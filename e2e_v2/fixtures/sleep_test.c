#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <time.h>
#include <unistd.h>

int main(void) {
    struct timespec t0, t1;
    if (clock_gettime(CLOCK_MONOTONIC, &t0) != 0) {
        perror("clock_gettime t0");
        return 1;
    }

    unsigned int rem = sleep(60);
    if (rem != 0) {
        fprintf(stderr, "sleep(60) returned remaining=%u\n", rem);
        return 1;
    }

    struct timespec req = { .tv_sec = 5, .tv_nsec = 0 };
    if (clock_nanosleep(CLOCK_MONOTONIC, 0, &req, NULL) != 0) {
        perror("clock_nanosleep");
        return 1;
    }

    if (clock_gettime(CLOCK_MONOTONIC, &t1) != 0) {
        perror("clock_gettime t1");
        return 1;
    }

    int64_t elapsed_ns =
        (int64_t)(t1.tv_sec - t0.tv_sec) * 1000000000LL +
        (int64_t)(t1.tv_nsec - t0.tv_nsec);

    printf("ELAPSED_NS=%lld\n", (long long)elapsed_ns);
    if (elapsed_ns < 65000000000LL) {
        fprintf(stderr, "elapsed_ns too small: %lld\n", (long long)elapsed_ns);
        return 1;
    }
    return 0;
}
