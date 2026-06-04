#include "process_loopback_hub.h"

#include "logging.h"
#include "process_loopback.h"
#include "ws_util.h"

#include <atomic>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

namespace companion {
namespace {

struct Subscriber {
  uint64_t id = 0;
  SOCKET s = INVALID_SOCKET;
  std::atomic<bool> alive{true};
};

struct ProcessLoopbackHub : std::enable_shared_from_this<ProcessLoopbackHub> {
  explicit ProcessLoopbackHub(DWORD p) : pid(p) {}

  DWORD pid = 0;
  std::mutex mu;
  std::map<uint64_t, std::shared_ptr<Subscriber>> subscribers;
  std::atomic<bool> capture_alive{true};
  std::thread capture_thread;
  bool started = false;

  void start();
  std::shared_ptr<Subscriber> subscribe(SOCKET s);
  void unsubscribe(uint64_t id);
  bool broadcast(const uint8_t* data, size_t bytes);
  void stop_all_subscribers();
};

std::mutex g_hubs_mu;
std::map<DWORD, std::weak_ptr<ProcessLoopbackHub>> g_hubs;
std::atomic<uint64_t> g_next_subscriber_id{1};

std::shared_ptr<ProcessLoopbackHub> hub_for_pid(DWORD pid) {
  std::lock_guard<std::mutex> lock(g_hubs_mu);
  auto existing = g_hubs[pid].lock();
  if (existing) return existing;

  auto hub = std::make_shared<ProcessLoopbackHub>(pid);
  g_hubs[pid] = hub;
  dlog("process loopback hub pid=%lu: created", pid);
  return hub;
}

void ProcessLoopbackHub::start() {
  {
    std::lock_guard<std::mutex> lock(mu);
    if (started) return;
    started = true;
  }
  auto self = shared_from_this();
  capture_thread = std::thread([self] {
    dlog("process loopback hub pid=%lu: capture thread starting", self->pid);
    capture_process_loopback(self->pid, self->capture_alive,
                             [self](const uint8_t* data, size_t bytes) {
                               return self->broadcast(data, bytes);
                             });
    self->capture_alive = false;
    self->stop_all_subscribers();
    {
      std::lock_guard<std::mutex> lock(g_hubs_mu);
      auto it = g_hubs.find(self->pid);
      if (it != g_hubs.end() && it->second.lock().get() == self.get()) {
        g_hubs.erase(it);
      }
    }
    dlog("process loopback hub pid=%lu: capture thread stopped", self->pid);
  });
  capture_thread.detach();
}

std::shared_ptr<Subscriber> ProcessLoopbackHub::subscribe(SOCKET s) {
  auto sub = std::make_shared<Subscriber>();
  sub->id = g_next_subscriber_id.fetch_add(1);
  sub->s = s;
  {
    std::lock_guard<std::mutex> lock(mu);
    subscribers[sub->id] = sub;
    dlog("process loopback hub pid=%lu: subscriber %llu joined (count=%zu)",
         pid, (unsigned long long)sub->id, subscribers.size());
  }
  start();
  return sub;
}

void ProcessLoopbackHub::unsubscribe(uint64_t id) {
  size_t remaining = 0;
  {
    std::lock_guard<std::mutex> lock(mu);
    auto it = subscribers.find(id);
    if (it != subscribers.end()) {
      it->second->alive = false;
      subscribers.erase(it);
    }
    remaining = subscribers.size();
  }
  dlog("process loopback hub pid=%lu: subscriber %llu left (count=%zu)",
       pid, (unsigned long long)id, remaining);
  if (remaining == 0) {
    capture_alive = false;
  }
}

bool ProcessLoopbackHub::broadcast(const uint8_t* data, size_t bytes) {
  std::vector<std::shared_ptr<Subscriber>> snapshot;
  {
    std::lock_guard<std::mutex> lock(mu);
    for (const auto& kv : subscribers) snapshot.push_back(kv.second);
  }

  if (snapshot.empty()) return false;

  bool any_alive = false;
  std::vector<uint64_t> failed;
  for (const auto& sub : snapshot) {
    if (!sub->alive.load()) {
      failed.push_back(sub->id);
      continue;
    }
    if (send_ws_binary(sub->s, data, bytes)) {
      any_alive = true;
    } else {
      sub->alive = false;
      failed.push_back(sub->id);
    }
  }

  if (!failed.empty()) {
    std::lock_guard<std::mutex> lock(mu);
    for (uint64_t id : failed) subscribers.erase(id);
  }

  return any_alive;
}

void ProcessLoopbackHub::stop_all_subscribers() {
  std::vector<std::shared_ptr<Subscriber>> snapshot;
  {
    std::lock_guard<std::mutex> lock(mu);
    for (const auto& kv : subscribers) snapshot.push_back(kv.second);
    subscribers.clear();
  }

  for (const auto& sub : snapshot) {
    sub->alive = false;
    shutdown(sub->s, SD_BOTH);
  }
}

}  // namespace

void process_loopback_hub_session(SOCKET s, DWORD pid) {
  auto hub = hub_for_pid(pid);
  auto sub = hub->subscribe(s);

  while (sub->alive.load() && hub->capture_alive.load()) {
    char tmp[2] = {};
    int r = recv(s, tmp, sizeof(tmp), 0);
    if (r <= 0) break;
  }

  sub->alive = false;
  hub->unsubscribe(sub->id);
}

}  // namespace companion
