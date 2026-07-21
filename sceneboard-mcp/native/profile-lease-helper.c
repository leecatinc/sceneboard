#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

static int frame(const char *value) {
  size_t length = strlen(value);
  return write(STDOUT_FILENO, value, length) == (ssize_t)length ? 0 : 1;
}

static int corrupt(int descriptor) {
  if (descriptor >= 0) close(descriptor);
  frame("corrupt\n");
  return 4;
}

int main(void) {
  pid_t parent = getppid();
  if (parent <= 1 || prctl(PR_SET_PDEATHSIG, SIGTERM) != 0 || getppid() != parent) {
    frame("unknown\n");
    return 3;
  }

  char record[257];
  size_t used = 0;
  while (used < sizeof(record) - 1) {
    ssize_t count = read(STDIN_FILENO, record + used, 1);
    if (count != 1) {
      frame("unknown\n");
      return 3;
    }
    if (record[used] == '\n') break;
    used += 1;
  }
  if (used == 0 || used >= sizeof(record) - 1 || record[used] != '\n') {
    frame("corrupt\n");
    return 4;
  }
  record[used] = '\0';

  int descriptor = openat(3, "profile.lease", O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (descriptor < 0) return corrupt(-1);
  if (fchmod(descriptor, 0600) != 0) return corrupt(descriptor);
  struct stat status;
  if (fstat(descriptor, &status) != 0 || !S_ISREG(status.st_mode) || status.st_uid != geteuid()
      || (status.st_mode & 0777) != 0600 || status.st_nlink != 1) return corrupt(descriptor);

  if (flock(descriptor, LOCK_EX | LOCK_NB) != 0) {
    close(descriptor);
    if (errno == EWOULDBLOCK || errno == EAGAIN) {
      frame("busy\n");
      return 2;
    }
    frame("unknown\n");
    return 3;
  }

  if (ftruncate(descriptor, 0) != 0 || lseek(descriptor, 0, SEEK_SET) < 0
      || write(descriptor, record, used) != (ssize_t)used || fsync(descriptor) != 0
      || lseek(descriptor, 0, SEEK_SET) < 0) return corrupt(descriptor);
  char check[257];
  ssize_t checked = read(descriptor, check, sizeof(check));
  if (checked != (ssize_t)used || memcmp(check, record, used) != 0) return corrupt(descriptor);
  if (frame("ready\n") != 0) {
    close(descriptor);
    return 3;
  }

  char control[64];
  while (read(STDIN_FILENO, control, sizeof(control)) > 0) {}
  close(descriptor);
  return 0;
}
