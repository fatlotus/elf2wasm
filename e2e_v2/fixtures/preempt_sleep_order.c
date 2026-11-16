#define _POSIX_C_SOURCE 200809L
#include <stdint.h>
#include <stdio.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static int64_t mono_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000000000LL + (int64_t)ts.tv_nsec;
}

static void sleep_ms(long ms) {
    struct timespec req = { .tv_sec = ms / 1000, .tv_nsec = (ms % 1000) * 1000000L };
    nanosleep(&req, NULL);
}

int main(void) {
    int64_t t0 = mono_ns();
    int pfd[2];
    if (pipe(pfd) != 0) return 1;

    pid_t pid_a = fork();
    if (pid_a < 0) return 2;
    if (pid_a == 0) {
        close(pfd[0]);
        sleep_ms(50);
        int64_t dt_ms = (mono_ns() - t0) / 1000000LL;
        dprintf(pfd[1], "A:%lld\n", (long long)dt_ms);
        close(pfd[1]);
        _exit(11);
    }

    pid_t pid_b = fork();
    if (pid_b < 0) return 3;
    if (pid_b == 0) {
        close(pfd[0]);
        sleep_ms(20);
        int64_t dt_ms = (mono_ns() - t0) / 1000000LL;
        dprintf(pfd[1], "B:%lld\n", (long long)dt_ms);
        close(pfd[1]);
        _exit(22);
    }

    close(pfd[1]);
    int st1 = 0, st2 = 0;
    pid_t w1 = waitpid(-1, &st1, 0);
    pid_t w2 = waitpid(-1, &st2, 0);

    char buf[128];
    ssize_t n = 0, r;
    while (n < (ssize_t)sizeof(buf) - 1 && (r = read(pfd[0], buf + n, sizeof(buf) - 1 - n)) > 0) {
        n += r;
    }
    buf[n] = '\0';
    close(pfd[0]);

    printf("WAIT1=%d EXIT1=%d\n", (int)w1, WEXITSTATUS(st1));
    printf("WAIT2=%d EXIT2=%d\n", (int)w2, WEXITSTATUS(st2));
    printf("PIPE:\n%s", buf);
    printf("ORDER_OK=%d\n", (w1 == pid_b && w2 == pid_a && WEXITSTATUS(st1) == 22 && WEXITSTATUS(st2) == 11) ? 1 : 0);
    return (w1 == pid_b && w2 == pid_a) ? 0 : 4;
}
