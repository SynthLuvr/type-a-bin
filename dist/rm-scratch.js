import { rmSync } from "node:fs";
const RM_OPTIONS = {
    recursive: true,
    force: true,
    maxRetries: 40,
    retryDelay: 250,
};
/**
 * Removes a scratch directory tree without ever throwing. Deletion is
 * retried because Windows — and busy filesystems generally — can
 * transiently deny removing files a just-exited process still holds;
 * a removal that still fails warns, since an unclean temp directory
 * beats failing a suite that passed.
 *
 * @param dir - Directory to remove; missing paths are fine (`force`)
 */
const rmScratch = (dir) => {
    try {
        rmSync(dir, RM_OPTIONS);
    }
    catch (err) {
        console.error(`warning: could not remove ${dir}: ${String(err)}`);
    }
};
export { rmScratch };
