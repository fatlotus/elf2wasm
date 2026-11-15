#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv) {
    const char *exec_target = NULL;
    const char *shared_path = "/tmp/elf2wasm_multiproc_shared.txt";

    if (argc >= 3 && strcmp(argv[1], "--exec") == 0) {
        exec_target = argv[2];
        if (argc >= 4) {
            shared_path = argv[3];
        }
    } else if (argc >= 2) {
        shared_path = argv[1];
    }

    unlink(shared_path);

    int pipefd[2];
    if (pipe(pipefd) != 0) {
        perror("pipe");
        return 1;
    }

    pid_t pid = fork();
    if (pid < 0) {
        perror("fork");
        return 1;
    }

    if (pid == 0) {
        close(pipefd[0]);
        if (dup2(pipefd[1], STDOUT_FILENO) < 0) {
            _exit(10);
        }
        close(pipefd[1]);

        if (exec_target != NULL) {
            char *const child_argv[] = { (char *)exec_target, NULL };
            char *const child_envp[] = { NULL };
            execve(exec_target, child_argv, child_envp);
            _exit(11);
        } else {
            int sfd = open(shared_path, O_CREAT | O_TRUNC | O_WRONLY, 0644);
            if (sfd < 0) {
                _exit(12);
            }
            const char *vfs_msg = "FROM_CHILD_VFS";
            if (write(sfd, vfs_msg, strlen(vfs_msg)) != (ssize_t)strlen(vfs_msg)) {
                _exit(13);
            }
            close(sfd);

            const char *pipe_msg = "FROM_CHILD_PIPE";
            if (write(STDOUT_FILENO, pipe_msg, strlen(pipe_msg)) != (ssize_t)strlen(pipe_msg)) {
                _exit(14);
            }
            _exit(7);
        }
    }

    close(pipefd[1]);

    char pipe_buf[256];
    size_t total = 0;
    while (total < sizeof(pipe_buf) - 1) {
        ssize_t n = read(pipefd[0], pipe_buf + total, sizeof(pipe_buf) - 1 - total);
        if (n < 0) {
            if (errno == EINTR) continue;
            perror("read pipe");
            return 1;
        }
        if (n == 0) break;
        total += (size_t)n;
    }
    pipe_buf[total] = '\0';
    close(pipefd[0]);

    int status = 0;
    if (waitpid(pid, &status, 0) != pid) {
        perror("waitpid");
        return 1;
    }
    if (!WIFEXITED(status)) {
        fprintf(stderr, "child did not exit normally: status=%d\n", status);
        return 1;
    }
    int exit_code = WEXITSTATUS(status);

    /* Trim trailing newline for clean single-line output if exec'd */
    while (total > 0 && (pipe_buf[total - 1] == '\n' || pipe_buf[total - 1] == '\r')) {
        pipe_buf[--total] = '\0';
    }
    printf("PIPE_MSG=%s\n", pipe_buf);
    printf("CHILD_EXIT=%d\n", exit_code);

    if (exec_target == NULL) {
        int sfd = open(shared_path, O_RDONLY);
        if (sfd < 0) {
            perror("parent open shared_path");
            return 1;
        }
        char vfs_buf[128];
        ssize_t vn = read(sfd, vfs_buf, sizeof(vfs_buf) - 1);
        if (vn < 0) {
            perror("parent read shared_path");
            return 1;
        }
        vfs_buf[vn] = '\0';
        close(sfd);
        unlink(shared_path);
        printf("VFS_MSG=%s\n", vfs_buf);
        if (exit_code != 7 || strcmp(pipe_buf, "FROM_CHILD_PIPE") != 0 ||
            strcmp(vfs_buf, "FROM_CHILD_VFS") != 0) {
            return 1;
        }
    }

    printf("MULTIPROC_OK\n");
    return 0;
}
