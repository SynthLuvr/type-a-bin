/*
 * type-a-bin Windows trampoline launcher.
 *
 * Every Windows mock that mockBin puts on PATH is a copy of this
 * executable, named after the mocked binary. The launcher does exactly
 * one thing: start the Node bootstrap that sits next to it, passing the
 * launcher's own path and the caller's original arguments, with no
 * shell in between:
 *
 *   NODE_EXE TEMP_DIR\mock-bin-trampoline.cjs TEMP_DIR\claude.exe args…
 *
 * Because a real script (the bootstrap) is Node's first positional
 * argument, the original arguments — including leading `--flags`,
 * spaces, quotes, and line breaks — travel in the child's argv and are
 * never interpreted by Node's own option parser or by cmd.exe.
 *
 * Build (see native/build-trampolines.sh):
 *
 *   clang --target=x86_64-w64-windows-gnu  -Os -static -s \
 *     trampoline.c -lshell32 -o type-a-bin-trampoline.exe
 *   clang --target=aarch64-w64-windows-gnu -Os -static -s \
 *     trampoline.c -lshell32 -o type-a-bin-trampoline.exe
 *
 * The launcher is a plain Win32 program: the CRT is statically linked
 * so the binary runs with no runtime dependencies beyond the OS.
 */

/* NOLINTBEGIN: this is C, not TypeScript tooling territory */
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN

#include <windows.h>
#include <shellapi.h>

#include <stdio.h>
#include <stddef.h>
#include <wchar.h>

/* Matches PATHCCH_MAX_CCH; Windows paths cannot be longer in wide form. */
#define MAX_PATH_W 32768
/* Lookup/launch failures exit 127, matching the library's POSIX mocks. */
#define EXIT_LAUNCH_FAILURE 127
/* CreateProcessW command lines cannot exceed this many wide characters. */
#define MAX_COMMAND_LINE 32767

/* Environment variable holding the Node executable to launch; set by
 * mockBin when the trampoline is installed. */
static const wchar_t NODE_EXE_VAR[] = L"TYPE_A_BIN_NODE_EXE";
/* The JavaScript bootstrap always sits next to the launcher copy. */
static const wchar_t BOOTSTRAP_NAME[] = L"mock-bin-trampoline.cjs";

/*
 * Writes a narrow, ASCII-only diagnostic to the caller's stderr and
 * returns the launch-failure exit code. stderr may be a pipe, so the
 * message goes through WriteFile, not the console API.
 */
static int fail(DWORD error, const char *message)
{
    char line[512];
    int length =
        _snprintf(line, sizeof(line), "%s (Windows error %lu)\n", message,
                  (unsigned long)error);
    if (length < 0 || (size_t)length >= sizeof(line))
        length = (int)sizeof(line) - 1;

    HANDLE error_stream = GetStdHandle(STD_ERROR_HANDLE);
    if (error_stream != INVALID_HANDLE_VALUE) {
        DWORD written = 0;
        WriteFile(error_stream, line, (DWORD)length, &written, NULL);
    }
    return EXIT_LAUNCH_FAILURE;
}

/*
 * Whitespace per the CRT argv rules: any of these inside an argument
 * force quoting, and quoted segments keep line breaks intact.
 */
static int is_argv_whitespace(wchar_t character)
{
    return character == L' ' || character == L'\t' || character == L'\n' ||
           character == L'\v' || character == L'\f' || character == L'\r';
}

/*
 * Upper bound on the wide characters append_quoted() emits for an
 * argument: every backslash may double, every embedded quote gains a
 * backslash, and surrounding quotes add two.
 */
static size_t quoted_length_upper_bound(const wchar_t *argument)
{
    size_t length = 0;
    int needs_quotes = *argument == L'\0';

    for (const wchar_t *cursor = argument; *cursor != L'\0'; cursor++) {
        if (is_argv_whitespace(*cursor) || *cursor == L'"')
            needs_quotes = 1;
        length += (*cursor == L'\\' || *cursor == L'"') ? 2 : 1;
    }
    return length + (needs_quotes ? 2u : 0u);
}

/*
 * Appends an argument using the canonical Windows argv quoting rules
 * (the same ones MSVCRT and Node use to parse command lines): backslash
 * runs double only before a quote or at the end, embedded quotes are
 * escaped with a backslash, and anything containing whitespace or
 * quotes — or an empty string — is wrapped in quotes.
 */
static void append_quoted(wchar_t **out, const wchar_t *argument)
{
    wchar_t *cursor = *out;
    int needs_quotes = *argument == L'\0';

    for (const wchar_t *scan = argument; *scan != L'\0'; scan++) {
        if (is_argv_whitespace(*scan) || *scan == L'"') {
            needs_quotes = 1;
            break;
        }
    }

    if (!needs_quotes) {
        while (*argument != L'\0')
            *cursor++ = *argument++;
        *out = cursor;
        return;
    }

    *cursor++ = L'"';
    size_t backslashes = 0;
    for (const wchar_t *scan = argument; *scan != L'\0'; scan++) {
        if (*scan == L'\\') {
            backslashes++;
            continue;
        }
        if (*scan == L'"') {
            for (size_t i = 0; i < backslashes * 2 + 1; i++)
                *cursor++ = L'\\';
            *cursor++ = L'"';
        } else {
            for (size_t i = 0; i < backslashes; i++)
                *cursor++ = L'\\';
            *cursor++ = *scan;
        }
        backslashes = 0;
    }
    for (size_t i = 0; i < backslashes * 2; i++)
        *cursor++ = L'\\';
    *cursor++ = L'"';
    *out = cursor;
}

int wmain(void)
{
    wchar_t exe_path[MAX_PATH_W];
    DWORD exe_length = GetModuleFileNameW(NULL, exe_path, MAX_PATH_W);
    if (exe_length == 0 || exe_length >= MAX_PATH_W)
        return fail(GetLastError(),
                    "type-a-bin: could not determine the mock executable");

    wchar_t node_exe[MAX_PATH_W];
    DWORD node_length =
        GetEnvironmentVariableW(NODE_EXE_VAR, node_exe, MAX_PATH_W);
    if (node_length == 0 || node_length >= MAX_PATH_W)
        return fail(ERROR_ENVVAR_NOT_FOUND,
                    "type-a-bin: TYPE_A_BIN_NODE_EXE is not set; "
                    "mockBin installs it with the launcher");

    /* The bootstrap path is the launcher's directory plus the fixed
     * bootstrap file name; derive it by replacing the file name. */
    wchar_t bootstrap[MAX_PATH_W];
    wchar_t *last_slash = wcsrchr(exe_path, L'\\');
    if (last_slash == NULL)
        return fail(ERROR_INVALID_NAME,
                    "type-a-bin: mock executable path has no directory");
    size_t directory_length = (size_t)(last_slash + 1 - exe_path);
    if (directory_length + wcslen(BOOTSTRAP_NAME) >= MAX_PATH_W)
        return fail(ERROR_INVALID_NAME,
                    "type-a-bin: mock directory path is too long");
    wmemcpy(bootstrap, exe_path, directory_length);
    wcscpy(bootstrap + directory_length, BOOTSTRAP_NAME);

    /* Parse the raw command line so the original arguments survive
     * exactly as the caller (typically Node's spawn) quoted them. */
    int argument_count = 0;
    wchar_t **arguments = CommandLineToArgvW(GetCommandLineW(), &argument_count);
    if (arguments == NULL)
        return fail(GetLastError(),
                    "type-a-bin: could not parse the command line");

    /* Assemble the child command line:
     *   node bootstrap mock-exe [original arguments…] */
    size_t total = quoted_length_upper_bound(node_exe) + 1 +
                   quoted_length_upper_bound(bootstrap) + 1 +
                   quoted_length_upper_bound(exe_path);
    for (int index = 1; index < argument_count; index++)
        total += 1 + quoted_length_upper_bound(arguments[index]);

    if (total >= MAX_COMMAND_LINE) {
        LocalFree(arguments);
        return fail(ERROR_NOT_ENOUGH_MEMORY,
                    "type-a-bin: rebuilt command line is too long");
    }

    wchar_t *command_line =
        HeapAlloc(GetProcessHeap(), 0, (total + 1) * sizeof(wchar_t));
    if (command_line == NULL) {
        LocalFree(arguments);
        return fail(ERROR_NOT_ENOUGH_MEMORY,
                    "type-a-bin: out of memory building the command line");
    }

    wchar_t *cursor = command_line;
    append_quoted(&cursor, node_exe);
    *cursor++ = L' ';
    append_quoted(&cursor, bootstrap);
    *cursor++ = L' ';
    append_quoted(&cursor, exe_path);
    for (int index = 1; index < argument_count; index++) {
        *cursor++ = L' ';
        append_quoted(&cursor, arguments[index]);
    }
    *cursor = L'\0';
    LocalFree(arguments);

    /* A Job Object with KILL_ON_JOB_CLOSE makes terminating the
     * trampoline reap the Node mock and any descendants it spawned,
     * preserving the kill-the-spawned-tree behaviour of a direct mock.
     * The flag is cleared again on normal completion so descendants
     * that a mock intentionally leaves behind can outlive it. */
    HANDLE job = CreateJobObjectW(NULL, NULL);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
    if (job != NULL) {
        ZeroMemory(&limits, sizeof(limits));
        limits.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                     &limits, sizeof(limits))) {
            CloseHandle(job);
            job = NULL;
        }
    }

    /* Inherit this process's own STARTUPINFO so the child receives the
     * same standard handles, window, and console flags the caller gave
     * the launcher. The child is created suspended so it can join the
     * job before any of its code runs. */
    STARTUPINFOW startup;
    GetStartupInfoW(&startup);
    PROCESS_INFORMATION child;
    ZeroMemory(&child, sizeof(child));

    if (!CreateProcessW(NULL, command_line, NULL, NULL, TRUE,
                        CREATE_SUSPENDED, NULL, NULL, &startup, &child)) {
        DWORD error = GetLastError();
        if (job != NULL)
            CloseHandle(job);
        HeapFree(GetProcessHeap(), 0, command_line);
        return fail(error, "type-a-bin: failed to start the mock");
    }

    if (job != NULL)
        AssignProcessToJobObject(job, child.hProcess);
    ResumeThread(child.hThread);
    CloseHandle(child.hThread);

    WaitForSingleObject(child.hProcess, INFINITE);
    DWORD exit_code = EXIT_LAUNCH_FAILURE;
    GetExitCodeProcess(child.hProcess, &exit_code);
    CloseHandle(child.hProcess);
    /* The mock finished on its own: release the tree it leaves behind.
     * The scripted-behaviour convention spawns bounded descendants that
     * outlive a completed mock, so clear KILL_ON_JOB_CLOSE before this
     * handle goes away — a terminated trampoline never reaches this
     * point, and its kernel-closed handle still reaps the whole tree. */
    if (job != NULL) {
        ZeroMemory(&limits, sizeof(limits));
        SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                &limits, sizeof(limits));
        CloseHandle(job);
    }
    HeapFree(GetProcessHeap(), 0, command_line);
    return (int)exit_code;
}
/* NOLINTEND */
