#include "env.h"

#include <cstdlib>

namespace companion {

std::string getenv_string(const char* name) {
  const char* value = std::getenv(name);
  return value ? std::string(value) : std::string();
}

}  // namespace companion
