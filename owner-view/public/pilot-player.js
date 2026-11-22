"use strict";
(() => {
  const panel = document.querySelector("[data-media-pilot]");
  const path = panel.dataset.mediaPilot;
  const label = document.getElementById("pilot-state");
  const video = document.getElementById("pilot-video");
  const start = document.getElementById("pilot-start");
  const labels = {
    waiting: "Ready to broadcast", starting: "Starting broadcast…", live: "Live",
    processing: "Preparing replay…", replay: "Replay ready", unavailable: "Broadcast unavailable",
  };
  let mode;
  let hls;
  let timer;
  function stop() {
    hls?.destroy();
    hls = undefined;
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.hidden = true;
  }
  function show(state) {
    label.textContent = labels[state] ?? labels.unavailable;
    if (start) start.hidden = state !== "waiting";
    if (state === mode) return;
    mode = state;
    stop();
    if (state === "live" && window.Hls?.isSupported()) {
      hls = new window.Hls({ enableWorker: false, maxBufferLength: 10 });
      hls.loadSource(path + "/hls/index.m3u8");
      hls.attachMedia(video);
    } else if (state === "live" && video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = path + "/hls/index.m3u8";
    } else if (state === "replay") {
      video.src = path + "/replay.mp4";
    } else if (state === "live") {
      label.textContent = "This browser cannot play the live broadcast.";
      return;
    } else {
      return;
    }
    video.hidden = false;
  }
  async function update() {
    try {
      const response = await fetch(path + "/state", { cache: "no-store", redirect: "error" });
      if (response.status === 403 || response.status === 404 || response.status === 401) {
        show("unavailable");
        return;
      }
      show(response.ok ? (await response.json()).state : "unavailable");
    } catch {
      show("unavailable");
    }
    timer = setTimeout(update, 2500);
  }
  window.addEventListener("pagehide", () => { clearTimeout(timer); stop(); mode = undefined; });
  window.addEventListener("pageshow", () => { void update(); });
})();
