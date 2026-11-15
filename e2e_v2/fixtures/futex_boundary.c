#define _GNU_SOURCE
#include <errno.h>
#include <linux/futex.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

int main(void) {
    int uaddr = 42;

    /* 1. FUTEX_WAIT when *uaddr != val must return -1 with EAGAIN */
    errno = 0;
    long r1 = syscall(SYS_futex, &uaddr, FUTEX_WAIT, 99, NULL, NULL, 0);
    if (r1 != -1 || errno != EAGAIN) {
        fprintf(stderr, "expected FUTEX_WAIT mismatch EAGAIN, got r1=%ld errno=%d\n", r1, errno);
        return 1;
    }
    printf("FUTEX_EAGAIN=OK\n");

    /* 2. FUTEX_WAIT with relative timeout must return -1 with ETIMEDOUT and advance clock */
    struct timespec t0, t1;
    struct timespec to = { .tv_sec = 0, .tv_nsec = 50000000L }; /* 50ms */
    if (clock_gettime(CLOCK_MONOTONIC, &t0) != 0) {
        perror("clock_gettime t0");
        return 1;
    }
    errno = 0;
    long r2 = syscall(SYS_futex, &uaddr, FUTEX_WAIT, 42, &to, NULL, 0);
    if (r2 != -1 || errno != ETIMEDOUT) {
        fprintf(stderr, "expected FUTEX_WAIT timeout ETIMEDOUT, got r2=%ld errno=%d\n", r2, errno);
        return 1;
    }
    if (clock_gettime(CLOCK_MONOTONIC, &t1) != 0) {
        perror("clock_gettime t1");
        return 1;
    }
    int64_t elapsed_ns =
        (int64_t)(t1.tv_sec - t0.tv_sec) * 1000000000LL +
        (int64_t)(t1.tv_nsec - t0.tv_nsec);
    if (elapsed_ns < 50000000LL) {
        fprintf(stderr, "futex timeout did not advance clock >= 50ms: %lld\n", (long long)elapsed_ns);
        return 1;
    }
    printf("FUTEX_TIMEOUT=OK\n");

    /* 3. nanosleep(0, 0) must succeed */
    struct timespec zero = { .tv_sec = 0, .tv_nsec = 0 };
    if (nanosleep(&zero, NULL) != 0) {
        perror("nanosleep(0)");
        return 1;
    }
    printf("NANOSLEEP_ZERO=OK\n");

    /* 4. nanosleep with tv_nsec = 1000000000 must fail with EINVAL */
    struct timespec bad = { .tv_sec = 0, .tv_nsec = 1000000000L };
    errno = 0;
    if (nanosleep(&bad, NULL) != -1 || errno != EINVAL) {
        fprintf(stderr, "expected nanosleep EINVAL, got errno=%d\n", errno);
        return 1;
    }
    printf("NANOSLEEP_EINVAL=OK\n");

    printf("FUTEX_BOUNDARY_OK\n");
    return 0;
}
