#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#define MAX_FRAME_BYTES 65532U
#define MAX_COMPONENTS 64U
#define MAX_COMPONENT_BYTES 255U
#define MAX_PATH_BYTES 4096U
#define MAX_EXPORT_BYTES 536870912ULL

static volatile sig_atomic_t active_directory = -1;
static volatile sig_atomic_t active_temporary = 0;
static char active_temporary_name[58];

static void terminate_cleanly(int signal_number) {
  (void)signal_number;
  if (active_temporary && active_directory >= 0)
    (void)unlinkat((int)active_directory, active_temporary_name, 0);
  _exit(143);
}

static int write_all(int descriptor, const void *bytes, size_t length) {
  const unsigned char *cursor = bytes;
  while (length > 0) {
    ssize_t written = write(descriptor, cursor, length);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) return -1;
    cursor += (size_t)written;
    length -= (size_t)written;
  }
  return 0;
}

static int result(const char *code, uint64_t bytes) {
  char frame[96];
  int length = snprintf(frame, sizeof(frame), "SBEX/1 %s %llu\n", code,
                        (unsigned long long)bytes);
  if (length <= 0 || (size_t)length >= sizeof(frame)) return 1;
  return write_all(STDOUT_FILENO, frame, (size_t)length) == 0 ? 0 : 1;
}

static void diagnostic(const char *operation, int error_number) {
  char frame[96];
  int length = snprintf(frame, sizeof(frame), "SBEX/1 io %s errno=%d\n", operation, error_number);
  if (length > 0 && (size_t)length < sizeof(frame))
    (void)write_all(STDERR_FILENO, frame, (size_t)length);
}

static uint16_t read_u16(const unsigned char *bytes) {
  return (uint16_t)(((uint16_t)bytes[0] << 8U) | (uint16_t)bytes[1]);
}

static uint32_t read_u32(const unsigned char *bytes) {
  return ((uint32_t)bytes[0] << 24U) | ((uint32_t)bytes[1] << 16U) |
         ((uint32_t)bytes[2] << 8U) | (uint32_t)bytes[3];
}

static uint64_t read_u64(const unsigned char *bytes) {
  uint64_t value = 0;
  for (size_t index = 0; index < 8; index += 1) value = (value << 8U) | bytes[index];
  return value;
}

static int read_exact(int descriptor, unsigned char *bytes, size_t length) {
  size_t used = 0;
  while (used < length) {
    ssize_t count = read(descriptor, bytes + used, length - used);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return -1;
    used += (size_t)count;
  }
  return 0;
}

static int valid_utf8_without_combining_marks(const unsigned char *bytes, size_t length) {
  size_t index = 0;
  while (index < length) {
    unsigned char first = bytes[index];
    uint32_t point;
    size_t width;
    if (first <= 0x7fU) {
      point = first;
      width = 1;
    } else if (first >= 0xc2U && first <= 0xdfU) {
      point = (uint32_t)(first & 0x1fU);
      width = 2;
    } else if (first >= 0xe0U && first <= 0xefU) {
      point = (uint32_t)(first & 0x0fU);
      width = 3;
    } else if (first >= 0xf0U && first <= 0xf4U) {
      point = (uint32_t)(first & 0x07U);
      width = 4;
    } else {
      return 0;
    }
    if (index + width > length) return 0;
    for (size_t offset = 1; offset < width; offset += 1) {
      unsigned char next = bytes[index + offset];
      if ((next & 0xc0U) != 0x80U) return 0;
      point = (point << 6U) | (uint32_t)(next & 0x3fU);
    }
    if ((width == 2 && point < 0x80U) || (width == 3 && point < 0x800U) ||
        (width == 4 && point < 0x10000U) || point > 0x10ffffU ||
        (point >= 0xd800U && point <= 0xdfffU))
      return 0;
    /*
     * The trusted Node parent already enforces full Unicode NFC. Rejecting combining
     * mark code points here independently closes decomposed path-frame injection
     * without linking a locale-sensitive Unicode library into this tiny helper.
     */
    if ((point >= 0x0300U && point <= 0x036fU) || (point >= 0x1ab0U && point <= 0x1affU) ||
        (point >= 0x1dc0U && point <= 0x1dffU) || (point >= 0x20d0U && point <= 0x20ffU) ||
        (point >= 0xfe20U && point <= 0xfe2fU))
      return 0;
    index += width;
  }
  return 1;
}

static int safe_directory(int descriptor, int root) {
  struct stat status;
  if (fstat(descriptor, &status) != 0 || !S_ISDIR(status.st_mode) || status.st_nlink < 2)
    return 0;
  if (root) return status.st_uid == 0 && (status.st_mode & 0022) == 0;
  if (status.st_uid == geteuid()) return 1;
  return status.st_uid == 0 &&
         (((status.st_mode & 0022) == 0) || (status.st_mode & S_ISVTX) != 0);
}

static int random_temp_name(char output[58]) {
  unsigned char random[16];
  ssize_t count;
  do {
    count = getrandom(random, sizeof(random), 0);
  } while (count < 0 && errno == EINTR);
  if (count != (ssize_t)sizeof(random)) return -1;
  static const char hex[] = "0123456789abcdef";
  memcpy(output, ".sceneboard-export-", 19);
  for (size_t index = 0; index < sizeof(random); index += 1) {
    output[19 + index * 2] = hex[random[index] >> 4U];
    output[20 + index * 2] = hex[random[index] & 0x0fU];
  }
  memcpy(output + 51, ".tmp", 5);
  return 0;
}

static int helper_temp_name(const char *name) {
  if (strlen(name) != 55 || memcmp(name, ".sceneboard-export-", 19) != 0 ||
      memcmp(name + 51, ".tmp", 4) != 0)
    return 0;
  for (size_t index = 19; index < 51; index += 1)
    if (!((name[index] >= '0' && name[index] <= '9') ||
          (name[index] >= 'a' && name[index] <= 'f')))
      return 0;
  return 1;
}

static void recover_old_temporary_files(int directory) {
  int duplicate = dup(directory);
  if (duplicate < 0) return;
  DIR *entries = fdopendir(duplicate);
  if (entries == NULL) {
    close(duplicate);
    return;
  }
  time_t now = time(NULL);
  struct dirent *entry;
  while ((entry = readdir(entries)) != NULL) {
    if (!helper_temp_name(entry->d_name)) continue;
    struct stat status;
    if (fstatat(directory, entry->d_name, &status, AT_SYMLINK_NOFOLLOW) != 0 ||
        !S_ISREG(status.st_mode) || status.st_uid != geteuid() || status.st_nlink < 1 ||
        (status.st_mode & 0777) != 0600 || now == (time_t)-1 ||
        status.st_mtime > now - 300)
      continue;
    (void)unlinkat(directory, entry->d_name, 0);
  }
  closedir(entries);
}

static int publish_no_replace(int directory, const char *temporary, const char *final) {
  if (syscall(SYS_renameat2, directory, temporary, directory, final, RENAME_NOREPLACE) == 0)
    return 0;
  int rename_error = errno;
  if (rename_error == EEXIST) return 1;
  if (rename_error != EINVAL && rename_error != ENOSYS) {
    errno = rename_error;
    return -1;
  }
  if (linkat(directory, temporary, directory, final, 0) != 0)
    return errno == EEXIST ? 1 : -1;
  if (unlinkat(directory, temporary, 0) != 0) {
    diagnostic("unlink", errno);
    return 2;
  }
  return 0;
}

int main(void) {
  close(5);
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = terminate_cleanly;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) != 0 || sigaction(SIGINT, &action, NULL) != 0)
    return result("io", 0);
  pid_t parent = getppid();
  if (parent <= 1 || prctl(PR_SET_PDEATHSIG, SIGTERM) != 0 || getppid() != parent)
    return result("io", 0);
  if (!safe_directory(3, 1)) return result("invalid", 0);

  unsigned char length_bytes[4];
  if (read_exact(4, length_bytes, sizeof(length_bytes)) != 0) return result("invalid", 0);
  uint32_t frame_bytes = read_u32(length_bytes);
  if (frame_bytes < 24U || frame_bytes > MAX_FRAME_BYTES) return result("invalid", 0);
  unsigned char *frame = malloc(frame_bytes);
  if (frame == NULL) return result("io", 0);
  if (read_exact(4, frame, frame_bytes) != 0) {
    free(frame);
    return result("invalid", 0);
  }
  unsigned char trailing;
  ssize_t trailing_count;
  do {
    trailing_count = read(4, &trailing, 1);
  } while (trailing_count < 0 && errno == EINTR);
  close(4);
  if (trailing_count != 0) {
    free(frame);
    return result("invalid", 0);
  }
  if (memcmp(frame, "SBEX", 4) != 0 || read_u16(frame + 4) != 1 ||
      read_u16(frame + 6) != 0 || (frame[8] != 1 && frame[8] != 2) ||
      frame[9] == 0 || frame[9] > MAX_COMPONENTS || read_u16(frame + 10) != 0) {
    free(frame);
    return result("invalid", 0);
  }
  uint8_t format = frame[8];
  uint8_t component_count = frame[9];
  uint64_t expected_bytes = read_u64(frame + 12);
  uint32_t normalized_path_bytes = read_u32(frame + 20);
  if (expected_bytes == 0 || expected_bytes > MAX_EXPORT_BYTES ||
      normalized_path_bytes == 0 || normalized_path_bytes > MAX_PATH_BYTES) {
    free(frame);
    return result("invalid", 0);
  }

  size_t cursor = 24;
  char *components[MAX_COMPONENTS];
  size_t component_lengths[MAX_COMPONENTS];
  uint32_t calculated_path_bytes = 1;
  memset(components, 0, sizeof(components));
  for (uint8_t index = 0; index < component_count; index += 1) {
    if (cursor + 2 > frame_bytes) goto invalid;
    uint16_t component_bytes = read_u16(frame + cursor);
    cursor += 2;
    if (component_bytes == 0 || component_bytes > MAX_COMPONENT_BYTES ||
        cursor + component_bytes > frame_bytes ||
        !valid_utf8_without_combining_marks(frame + cursor, component_bytes))
      goto invalid;
    char *component = malloc((size_t)component_bytes + 1);
    if (component == NULL) goto io;
    memcpy(component, frame + cursor, component_bytes);
    component[component_bytes] = '\0';
    if (strcmp(component, ".") == 0 || strcmp(component, "..") == 0 ||
        memchr(component, '/', component_bytes) != NULL ||
        memchr(component, '\0', component_bytes) != NULL) {
      free(component);
      goto invalid;
    }
    components[index] = component;
    component_lengths[index] = component_bytes;
    calculated_path_bytes += component_bytes + (index == 0 ? 0U : 1U);
    cursor += component_bytes;
  }
  if (cursor != frame_bytes || calculated_path_bytes != normalized_path_bytes) goto invalid;
  const char *extension = format == 1 ? ".pdf" : ".pptx";
  size_t extension_length = strlen(extension);
  size_t final_length = component_lengths[component_count - 1];
  if (final_length <= extension_length ||
      memcmp(components[component_count - 1] + final_length - extension_length, extension,
             extension_length) != 0)
    goto invalid;

  int directory = dup(3);
  close(3);
  if (directory < 0) goto io;
  for (uint8_t index = 0; index + 1 < component_count; index += 1) {
    int next = openat(directory, components[index],
                      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0) {
      close(directory);
      goto invalid;
    }
    close(directory);
    directory = next;
    if (!safe_directory(directory, 0)) {
      close(directory);
      goto invalid;
    }
  }

  char temporary[58];
  recover_old_temporary_files(directory);
  if (random_temp_name(temporary) != 0) {
    close(directory);
    goto io;
  }
  int output = openat(directory, temporary,
                      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (output < 0) {
    diagnostic("openat", errno);
    close(directory);
    goto io;
  }
  active_directory = directory;
  memcpy(active_temporary_name, temporary, sizeof(active_temporary_name));
  active_temporary = 1;
  struct stat output_status;
  if (fchmod(output, 0600) != 0 || fstat(output, &output_status) != 0 ||
      !S_ISREG(output_status.st_mode) || output_status.st_uid != geteuid() ||
      output_status.st_nlink != 1 || (output_status.st_mode & 0777) != 0600) {
    diagnostic("fstat", errno);
    close(output);
    (void)unlinkat(directory, temporary, 0);
    active_temporary = 0;
    close(directory);
    goto io;
  }

  uint64_t received = 0;
  unsigned char payload[65536];
  while (received < expected_bytes) {
    size_t wanted =
        expected_bytes - received < sizeof(payload) ? (size_t)(expected_bytes - received)
                                                    : sizeof(payload);
    ssize_t count = read(STDIN_FILENO, payload, wanted);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) {
      close(output);
      (void)unlinkat(directory, temporary, 0);
      active_temporary = 0;
      close(directory);
      free(frame);
      for (uint8_t index = 0; index < component_count; index += 1) free(components[index]);
      return result("short", 0);
    }
    if (write_all(output, payload, (size_t)count) != 0) {
      diagnostic("write", errno);
      close(output);
      (void)unlinkat(directory, temporary, 0);
      active_temporary = 0;
      close(directory);
      goto io;
    }
    received += (uint64_t)count;
  }
  ssize_t extra;
  do {
    extra = read(STDIN_FILENO, payload, 1);
  } while (extra < 0 && errno == EINTR);
  if (extra != 0) {
    close(output);
    (void)unlinkat(directory, temporary, 0);
    active_temporary = 0;
    close(directory);
    free(frame);
    for (uint8_t index = 0; index < component_count; index += 1) free(components[index]);
    return result("corrupt", 0);
  }
  if (fstat(output, &output_status) != 0 || (uint64_t)output_status.st_size != expected_bytes ||
      fsync(output) != 0 || close(output) != 0) {
    diagnostic("fsync", errno);
    (void)unlinkat(directory, temporary, 0);
    active_temporary = 0;
    close(directory);
    goto io;
  }
  int published =
      publish_no_replace(directory, temporary, components[component_count - 1]);
  if (published == 1) {
    (void)unlinkat(directory, temporary, 0);
    active_temporary = 0;
    close(directory);
    free(frame);
    for (uint8_t index = 0; index < component_count; index += 1) free(components[index]);
    return result("exists", 0);
  }
  if (published < 0 || fsync(directory) != 0) {
    diagnostic("publish", errno);
    (void)unlinkat(directory, temporary, 0);
    active_temporary = 0;
    close(directory);
    goto io;
  }
  active_temporary = 0;
  close(directory);
  free(frame);
  for (uint8_t index = 0; index < component_count; index += 1) free(components[index]);
  return result("ok", expected_bytes);

invalid:
  free(frame);
  for (uint8_t index = 0; index < component_count; index += 1) free(components[index]);
  return result("invalid", 0);

io:
  free(frame);
  for (uint8_t index = 0; index < component_count; index += 1) free(components[index]);
  return result("io", 0);
}
