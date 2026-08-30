/**
 * Removes a scratch directory tree without ever throwing. Deletion is
 * retried because Windows — and busy filesystems generally — can
 * transiently deny removing files a just-exited process still holds;
 * a removal that still fails warns, since an unclean temp directory
 * beats failing a suite that passed.
 *
 * @param dir - Directory to remove; missing paths are fine (`force`)
 */
declare const rmScratch: (dir: string) => void;
export { rmScratch };
