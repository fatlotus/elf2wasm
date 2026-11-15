#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static void fail(const char *msg) {
    fprintf(stderr, "VFS_FAIL: %s (errno=%d: %s)\n", msg, errno, strerror(errno));
    exit(1);
}

int main(int argc, char **argv) {
    const char *base = (argc > 1 && argv[1][0] != '\0') ? argv[1] : "/tmp/elf2wasm_vfs_ops";
    char dir_path[512];
    char file1[512];
    char file2[512];

    snprintf(dir_path, sizeof(dir_path), "%s/sub", base);
    snprintf(file1, sizeof(file1), "%s/sub/test.txt", base);
    snprintf(file2, sizeof(file2), "%s/sub/renamed.txt", base);

    /* Ensure base exists (ignore EEXIST). */
    if (mkdir(base, 0755) != 0 && errno != EEXIST) {
        fail("mkdir base");
    }
    if (mkdir(dir_path, 0755) != 0 && errno != EEXIST) {
        fail("mkdir sub");
    }
    printf("VFS_MKDIR=OK\n");

    /* Create/truncate, write, lseek, read */
    int fd = open(file1, O_CREAT | O_TRUNC | O_RDWR, 0644);
    if (fd < 0) fail("open O_CREAT|O_TRUNC|O_RDWR");

    const char *payload = "HELLO_VFS_12345";
    ssize_t nw = write(fd, payload, 15);
    if (nw != 15) fail("write 15 bytes");

    if (lseek(fd, 0, SEEK_SET) != 0) fail("lseek SEEK_SET");

    char buf[64];
    memset(buf, 0, sizeof(buf));
    ssize_t nr = read(fd, buf, sizeof(buf) - 1);
    if (nr != 15 || memcmp(buf, payload, 15) != 0) fail("read back 15 bytes");
    printf("VFS_WRITE_READ=OK\n");

    /* ftruncate to 5 bytes ("HELLO") */
    if (ftruncate(fd, 5) != 0) fail("ftruncate to 5");
    struct stat st;
    if (fstat(fd, &st) != 0) fail("fstat after ftruncate");
    if (st.st_size != 5) fail("size != 5 after ftruncate");
    if (close(fd) != 0) fail("close after ftruncate");
    printf("VFS_FTRUNCATE=OK\n");

    /* O_APPEND */
    fd = open(file1, O_WRONLY | O_APPEND);
    if (fd < 0) fail("open O_WRONLY|O_APPEND");
    if (write(fd, "_APPEND", 7) != 7) fail("write append 7 bytes");
    if (close(fd) != 0) fail("close append");

    if (stat(file1, &st) != 0) fail("stat after append");
    if (st.st_size != 12 || !S_ISREG(st.st_mode)) fail("stat size != 12 or not regular file");
    printf("VFS_APPEND=OK\n");

    /* O_RDONLY write must fail with EBADF or EACCES */
    int ro_fd = open(file1, O_RDONLY);
    if (ro_fd < 0) fail("open O_RDONLY");
    errno = 0;
    ssize_t bad_w = write(ro_fd, "X", 1);
    int saved_errno = errno;
    if (bad_w != -1 || (saved_errno != EBADF && saved_errno != EACCES)) {
        fprintf(stderr, "expected write on O_RDONLY to fail with EBADF/EACCES, got %zd errno=%d\n",
                bad_w, saved_errno);
        return 1;
    }
    printf("VFS_RDONLY_WRITE_ERR=%d\n", saved_errno);

    memset(buf, 0, sizeof(buf));
    nr = read(ro_fd, buf, sizeof(buf) - 1);
    if (nr != 12 || memcmp(buf, "HELLO_APPEND", 12) != 0) fail("read HELLO_APPEND");
    if (close(ro_fd) != 0) fail("close ro_fd");

    /* rename */
    if (rename(file1, file2) != 0) fail("rename");
    if (stat(file1, &st) == 0 || errno != ENOENT) fail("old path still exists after rename");
    if (stat(file2, &st) != 0 || st.st_size != 12) fail("new path missing after rename");
    printf("VFS_RENAME=OK\n");

    /* unlink */
    if (unlink(file2) != 0) fail("unlink");
    if (stat(file2, &st) == 0 || errno != ENOENT) fail("file still exists after unlink");
    printf("VFS_UNLINK=OK\n");

    printf("VFS_ALL_OK\n");
    return 0;
}
