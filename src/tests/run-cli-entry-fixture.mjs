// Entry fixture for the in-process runCliAsMain test: records the argv
// it was repositioned to, the way a real CLI entry reads its command
// line at process.argv.slice(2).
globalThis.__runCliEntryArgs = process.argv.slice(2);
