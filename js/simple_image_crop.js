import { app } from "../../scripts/app.js";

const NODE_NAME = "SimpleCrop";
const DEFAULT_RECT = { x: 0, y: 0, width: 512, height: 512 };
const HANDLE_HIT = 10;
// Placeholder height before any media is loaded. Once a media size is known, the
// canvas's real pixel resolution and displayed size both track it exactly (no caps) —
// clamping either one independently is what caused the resize-blur and portrait-video
// aspect-ratio bugs.
const MIN_CANVAS_H = 160;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Hit-test the crop rectangle in canvas-pixel space; returns a drag mode or null.
function rectHitTest(mx, my, x1, y1, x2, y2, r) {
  const nearL = Math.abs(mx - x1) < r;
  const nearR = Math.abs(mx - x2) < r;
  const nearT = Math.abs(my - y1) < r;
  const nearB = Math.abs(my - y2) < r;
  if (nearL && nearT) return "resize-tl";
  if (nearR && nearT) return "resize-tr";
  if (nearL && nearB) return "resize-bl";
  if (nearR && nearB) return "resize-br";
  if (nearT && mx > x1 + r && mx < x2 - r) return "resize-t";
  if (nearB && mx > x1 + r && mx < x2 - r) return "resize-b";
  if (nearL && my > y1 + r && my < y2 - r) return "resize-l";
  if (nearR && my > y1 + r && my < y2 - r) return "resize-r";
  if (mx >= x1 && mx <= x2 && my >= y1 && my <= y2) return "move";
  return null;
}

function cursorFor(mode) {
  switch (mode) {
    case "move": return "move";
    case "resize-tl": case "resize-br": return "nwse-resize";
    case "resize-tr": case "resize-bl": return "nesw-resize";
    case "resize-t": case "resize-b": return "ns-resize";
    case "resize-l": case "resize-r": return "ew-resize";
    default: return "default";
  }
}

// Natural pixel size of a drawable media element (<img> or <video>).
function mediaSize(el) {
  if (!el) return { w: 0, h: 0 };
  if (el.tagName === "VIDEO") return { w: el.videoWidth, h: el.videoHeight };
  return { w: el.naturalWidth, h: el.naturalHeight };
}

// Build a /view URL for a ComfyUI output-image descriptor ({filename, subfolder, type}).
function outputImageUrl(images) {
  const im = images?.[0];
  if (!im) return null;
  const params = new URLSearchParams({
    filename: im.filename,
    type: im.type || "output",
    subfolder: im.subfolder || "",
  });
  return `./view?${params.toString()}`;
}

// A node's last-known preview images: app.nodeOutputs is the current, version-stable source
// (populated both right after LoadImage-style file selection and after execution). Older
// frontend builds instead stash a cached <img> on node.imgs, so fall back to that too.
function nodePreviewUrl(node) {
  const fromOutputs = outputImageUrl(app.nodeOutputs?.[node.id]?.images);
  if (fromOutputs) return fromOutputs;
  if (node.imgs && node.imgs.length) return node.imgs[0].src;
  return null;
}

function looksLikeVideoUrl(url) {
  return /filename=[^&]*\.(mp4|webm|mov|mkv|avi|m4v)(&|$)/i.test(url);
}

// Load a raw video file (e.g. core LoadVideo's uploaded source, served as-is via /view —
// no VHS-style downscaling involved) far enough to read its true dimensions and grab one
// visible frame. preload="metadata" avoids pulling the whole file over the network; the
// small seek afterwards nudges the browser to actually decode a frame instead of leaving
// the canvas blank. Times out rather than hanging refreshPreview if seeking never resolves
// (e.g. the server doesn't support range requests).
function tryLoadRawVideo(url) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "metadata";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    v.onerror = () => finish(null);
    v.onloadedmetadata = () => {
      try {
        v.currentTime = Math.min(0.1, (v.duration || 1) / 2);
      } catch (e) {
        finish(v);
      }
    };
    v.onseeked = () => finish(v);
    setTimeout(() => finish(v.readyState > 0 ? v : null), 4000);
    v.src = url;
  });
}

// VideoHelperSuite (and compatible) loader nodes show their own preview through a DOM
// widget named "videopreview" holding either a <video> or an (animated-image) <img>
// element. Grab whichever is currently visible so we can draw its live current frame.
function resolveVideoPreviewWidget(node) {
  const vp = node.widgets?.find((w) => w.name === "videopreview");
  if (!vp) return null;
  if (vp.videoEl && !vp.videoEl.hidden && vp.videoEl.src) return { widget: vp, el: vp.videoEl };
  if (vp.imgEl && !vp.imgEl.hidden && vp.imgEl.src) return { widget: vp, el: vp.imgEl };
  return null;
}

// VHS's own inline preview is a bandwidth-saving downscaled stream (it asks the server
// for a "force_size"-limited video) — its videoWidth/videoHeight can be much smaller than
// the frames VHS_LoadVideo will actually output. Resolve the *true* output size instead:
// an explicit custom_width/custom_height override on the loader node if set, otherwise the
// source file's native size via VHS's own /vhs/queryvideo metadata endpoint.
async function resolveTrueVideoSize(node, vpWidget) {
  const cw = node.widgets?.find((w) => w.name === "custom_width")?.value;
  const ch = node.widgets?.find((w) => w.name === "custom_height")?.value;
  if (cw > 0 && ch > 0) return { w: cw, h: ch };
  const params = vpWidget?.value?.params;
  if (!params?.filename) return null;
  try {
    const res = await fetch("./vhs/queryvideo?" + new URLSearchParams(params).toString());
    if (!res.ok) return null;
    const data = await res.json();
    const size = data?.source?.size;
    if (Array.isArray(size) && size[0] > 0 && size[1] > 0) return { w: size[0], h: size[1] };
  } catch (e) {
    // Not a VHS node, or the endpoint changed — fall back to the (possibly downscaled)
    // preview element's own size at the call site.
  }
  return null;
}

// Resolve the best available preview for a node: a live media element if it has one
// (e.g. a video loader's own preview), otherwise a static image URL — and if that URL
// is actually a video file (e.g. core LoadVideo's uploaded source, which has no preview
// widget of its own), load it directly rather than trying to show it as an <img>.
async function resolveNodePreview(node) {
  const vp = resolveVideoPreviewWidget(node);
  if (vp) {
    const trueSize = await resolveTrueVideoSize(node, vp.widget);
    return { el: vp.el, isVideo: vp.el.tagName === "VIDEO", sizeOverride: trueSize, sizeConfirmed: !!trueSize };
  }
  const url = nodePreviewUrl(node);
  if (!url) return null;
  if (looksLikeVideoUrl(url)) {
    const videoEl = await tryLoadRawVideo(url);
    if (videoEl) return { el: videoEl, isVideo: true, sizeConfirmed: true };
  }
  return { url };
}

const MAX_PREVIEW_WALK_HOPS = 4;
const MAX_PREVIEW_WALK_NODES = 40;

// Some nodes (e.g. core ComfyUI's "Get Video Components") are pure computation with no
// preview of their own — their IMAGE output only exists once the graph actually runs, so
// there's nothing client-side to show. Walk further upstream through such a node's own
// inputs to find one that DOES have something to show (e.g. the Load Video node feeding
// it). Bounded by both hop depth and a total-nodes-visited budget so a node with many
// inputs can't blow this up into an exponential search.
async function resolveNodePreviewChain(node, depth, budget) {
  if (!node || depth > MAX_PREVIEW_WALK_HOPS || budget.remaining <= 0) return null;
  budget.remaining--;
  const direct = await resolveNodePreview(node);
  if (direct) return direct;
  if (!node.inputs || !node.graph) return null;
  for (const input of node.inputs) {
    if (budget.remaining <= 0) break;
    if (input.link == null) continue;
    const link = node.graph.links?.get?.(input.link) ?? node.graph.links?.[input.link];
    if (!link) continue;
    const upstream = node.graph.getNodeById(link.origin_id);
    if (!upstream) continue;
    const result = await resolveNodePreviewChain(upstream, depth + 1, budget);
    if (result) return result;
  }
  return null;
}

// The node directly feeding a given input slot, or null if that slot is unconnected.
function findDirectSourceNode(node, inputName) {
  const slot = node.inputs?.findIndex((inp) => inp.name === inputName);
  if (slot == null || slot < 0) return null;
  const input = node.inputs[slot];
  if (!input || input.link == null || !node.graph) return null;
  const link = node.graph.links?.get?.(input.link) ?? node.graph.links?.[input.link];
  if (!link) return null;
  return node.graph.getNodeById(link.origin_id);
}

// Find the node feeding our "image" input and resolve its current preview, if any —
// walking further upstream past pure-computation nodes when needed.
async function resolveUpstreamPreview(node) {
  const srcNode = findDirectSourceNode(node, "image");
  if (!srcNode) return null;
  return resolveNodePreviewChain(srcNode, 0, { remaining: MAX_PREVIEW_WALK_NODES });
}

app.registerExtension({
  name: "SimpleCrop.ImageCrop",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_NAME) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      setupCropWidget(this);
      return r;
    };
  },
});

function setupCropWidget(node) {
  const findW = (n) => node.widgets.find((w) => w.name === n);
  const xW = findW("x"), yW = findW("y"), wW = findW("width"), hW = findW("height");
  if (!xW || !yW || !wW || !hW) return;

  const wrapper = document.createElement("div");
  wrapper.style.cssText = "display:flex;flex-direction:column;gap:4px;width:100%;pointer-events:auto;";

  const statusEl = document.createElement("div");
  statusEl.style.cssText = "font:11px sans-serif;color:#999;display:flex;justify-content:space-between;align-items:center;gap:6px;";
  const statusText = document.createElement("span");
  statusText.textContent = "No preview yet";
  const refreshBtn = document.createElement("button");
  refreshBtn.textContent = "Refresh preview";
  refreshBtn.style.cssText = "background:#333;border:1px solid #555;border-radius:4px;color:#bbb;font:10px sans-serif;cursor:pointer;padding:2px 6px;flex-shrink:0;";
  refreshBtn.addEventListener("mousedown", (e) => e.stopPropagation());
  refreshBtn.addEventListener("click", () => refreshPreview());
  statusEl.append(statusText, refreshBtn);

  const canvasEl = document.createElement("canvas");
  canvasEl.style.cssText = "width:100%;height:auto;display:block;background:#1a1a1a;border-radius:4px;cursor:default;";
  canvasEl.width = 280;
  canvasEl.height = MIN_CANVAS_H;
  const ctx = canvasEl.getContext("2d");
  canvasEl.addEventListener("wheel", (e) => {
    const gc = document.getElementById("graph-canvas");
    if (gc) { gc.dispatchEvent(new WheelEvent(e.type, e)); e.preventDefault(); }
  }, { passive: false });

  wrapper.append(statusEl, canvasEl);

  const domWidget = node.addDOMWidget("crop_preview", "SimpleCropPreview", wrapper, {
    serialize: false,
    // Reserve exactly as much room as the canvas currently needs (it may be much
    // taller than MIN_CANVAS_H once a tall/portrait media source is loaded).
    getMinHeight: () => (canvasEl.height || MIN_CANVAS_H) + 24,
  });
  // Draw the preview above the x/y/width/height widgets instead of below them.
  const idx = node.widgets.indexOf(domWidget);
  if (idx > 0) {
    node.widgets.splice(idx, 1);
    node.widgets.unshift(domWidget);
  }

  setTimeout(() => {
    if (node.size[0] < 280) node.setSize([280, node.size[1]]);
  }, 0);

  const state = {
    mediaEl: null,
    naturalWidth: 0,
    naturalHeight: 0,
    dragging: false,
    dragMode: null,
    dragStart: null,
    rectAtDragStart: null,
    autoFitDone: false,
  };
  let watchedVideoEl = null;
  let syncSourceNode = null;

  function getRect() {
    return { x: xW.value, y: yW.value, width: wW.value, height: hW.value };
  }

  // When crop_info is connected, keep this node's box a live mirror of the upstream
  // Simple Image Crop node's own x/y/width/height widgets — dragging either node's
  // box should visibly move both, not just match up once the workflow actually runs.
  function readNodeRect(srcNode) {
    const sx = srcNode.widgets?.find((w) => w.name === "x");
    const sy = srcNode.widgets?.find((w) => w.name === "y");
    const sw = srcNode.widgets?.find((w) => w.name === "width");
    const sh = srcNode.widgets?.find((w) => w.name === "height");
    if (!sx || !sy || !sw || !sh) return null;
    return { x: sx.value, y: sy.value, width: sw.value, height: sh.value };
  }

  function setStatus(text) {
    statusText.textContent = syncSourceNode ? `${text} · synced from upstream node` : text;
  }

  function syncFromSource() {
    const srcNode = findDirectSourceNode(node, "crop_info");
    if (srcNode !== syncSourceNode) {
      syncSourceNode = srcNode;
      for (const w of [xW, yW, wW, hW]) w.disabled = !!srcNode;
      drawCanvas();
    }
    if (!syncSourceNode) return;
    const rect = readNodeRect(syncSourceNode);
    if (!rect) return;
    const cur = getRect();
    if (rect.x !== cur.x || rect.y !== cur.y || rect.width !== cur.width || rect.height !== cur.height) {
      state.autoFitDone = true;
      setRect(rect);
    }
  }

  function isDefaultRect() {
    const r = getRect();
    return r.x === DEFAULT_RECT.x && r.y === DEFAULT_RECT.y &&
      r.width === DEFAULT_RECT.width && r.height === DEFAULT_RECT.height;
  }

  function setRect(rect) {
    const nw = state.naturalWidth || 999999;
    const nh = state.naturalHeight || 999999;
    let { x, y, width, height } = rect;
    x = clamp(Math.round(x), 0, Math.max(0, nw - 1));
    y = clamp(Math.round(y), 0, Math.max(0, nh - 1));
    width = clamp(Math.round(width), 1, nw - x);
    height = clamp(Math.round(height), 1, nh - y);
    xW.value = x;
    yW.value = y;
    wW.value = width;
    hW.value = height;
    drawCanvas();
  }

  function fitCanvasSize() {
    const w = Math.max(200, node.size[0] - 20);
    // No max-height clamp: clamping it independently of width is what previously
    // squashed the aspect ratio for tall/portrait media.
    const h = (state.naturalWidth && state.naturalHeight)
      ? Math.max(1, Math.round(w * (state.naturalHeight / state.naturalWidth)))
      : MIN_CANVAS_H;
    if (canvasEl.width !== w || canvasEl.height !== h) {
      canvasEl.width = w;
      canvasEl.height = h;
    }
  }

  function imageToCanvasScale() {
    if (!state.naturalWidth || !state.naturalHeight) return { sx: 1, sy: 1 };
    return { sx: canvasEl.width / state.naturalWidth, sy: canvasEl.height / state.naturalHeight };
  }

  function rectInCanvasSpace() {
    const { sx, sy } = imageToCanvasScale();
    const rect = getRect();
    return {
      x1: rect.x * sx, y1: rect.y * sy,
      x2: (rect.x + rect.width) * sx, y2: (rect.y + rect.height) * sy,
    };
  }

  function drawCanvas() {
    fitCanvasSize();
    const w = canvasEl.width, h = canvasEl.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, w, h);

    if (!state.mediaEl || !state.naturalWidth) {
      ctx.fillStyle = "#777";
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Connect an image/video or run once to preview", w / 2, h / 2);
      return;
    }

    ctx.drawImage(state.mediaEl, 0, 0, w, h);

    const { x1, y1, x2, y2 } = rectInCanvasSpace();
    const rw = x2 - x1, rh = y2 - y1;

    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, 0, w, y1);
    ctx.fillRect(0, y2, w, h - y2);
    ctx.fillRect(0, y1, x1, rh);
    ctx.fillRect(x2, y1, w - x2, rh);

    ctx.strokeStyle = "#46b4e6";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x1, y1, rw, rh);

    ctx.fillStyle = "#46b4e6";
    const hs = 5;
    for (const [hx, hy] of [[x1, y1], [x2, y1], [x1, y2], [x2, y2]]) {
      ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
    }
  }

  function canvasMouse(e) {
    const bounds = canvasEl.getBoundingClientRect();
    return {
      x: (e.clientX - bounds.left) * (canvasEl.width / bounds.width),
      y: (e.clientY - bounds.top) * (canvasEl.height / bounds.height),
    };
  }

  canvasEl.addEventListener("mousedown", (e) => {
    if (!state.mediaEl || e.button !== 0 || syncSourceNode) return;
    const m = canvasMouse(e);
    const { x1, y1, x2, y2 } = rectInCanvasSpace();
    const mode = rectHitTest(m.x, m.y, x1, y1, x2, y2, HANDLE_HIT);
    if (!mode) return;
    state.dragging = true;
    state.dragMode = mode;
    state.dragStart = m;
    state.rectAtDragStart = getRect();
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragEnd);
    e.preventDefault();
    e.stopPropagation();
  });

  canvasEl.addEventListener("mousemove", (e) => {
    if (state.dragging || !state.mediaEl) return;
    if (syncSourceNode) {
      canvasEl.style.cursor = "not-allowed";
      return;
    }
    const m = canvasMouse(e);
    const { x1, y1, x2, y2 } = rectInCanvasSpace();
    const mode = rectHitTest(m.x, m.y, x1, y1, x2, y2, HANDLE_HIT);
    canvasEl.style.cursor = cursorFor(mode);
  });

  function onDragMove(e) {
    if (!state.dragging) return;
    const m = canvasMouse(e);
    const { sx, sy } = imageToCanvasScale();
    const dxImg = (m.x - state.dragStart.x) / sx;
    const dyImg = (m.y - state.dragStart.y) / sy;
    const start = state.rectAtDragStart;
    const x2 = start.x + start.width, y2 = start.y + start.height;
    let x = start.x, y = start.y, width = start.width, height = start.height;

    switch (state.dragMode) {
      case "move":
        x = start.x + dxImg;
        y = start.y + dyImg;
        break;
      case "resize-tl":
        x = start.x + dxImg; y = start.y + dyImg;
        width = x2 - x; height = y2 - y;
        break;
      case "resize-tr":
        y = start.y + dyImg;
        width = start.width + dxImg; height = y2 - y;
        break;
      case "resize-bl":
        x = start.x + dxImg;
        width = x2 - x; height = start.height + dyImg;
        break;
      case "resize-br":
        width = start.width + dxImg; height = start.height + dyImg;
        break;
      case "resize-t":
        y = start.y + dyImg; height = y2 - y;
        break;
      case "resize-b":
        height = start.height + dyImg;
        break;
      case "resize-l":
        x = start.x + dxImg; width = x2 - x;
        break;
      case "resize-r":
        width = start.width + dxImg;
        break;
    }

    width = Math.max(4, width);
    height = Math.max(4, height);
    if (state.dragMode === "move") {
      x = clamp(x, 0, Math.max(0, state.naturalWidth - width));
      y = clamp(y, 0, Math.max(0, state.naturalHeight - height));
    }

    state.autoFitDone = true;
    setRect({ x, y, width, height });
  }

  function onDragEnd() {
    state.dragging = false;
    state.dragMode = null;
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", onDragEnd);
    node.graph?.setDirtyCanvas?.(true, true);
  }

  function onVideoTimeUpdate() {
    if (!state.dragging) drawCanvas();
  }

  function watchVideo(el) {
    if (watchedVideoEl === el) return;
    if (watchedVideoEl) watchedVideoEl.removeEventListener("timeupdate", onVideoTimeUpdate);
    watchedVideoEl = el;
    if (watchedVideoEl) watchedVideoEl.addEventListener("timeupdate", onVideoTimeUpdate);
  }

  // Adopt a resolved media element (<img> or <video>, possibly one owned by another
  // node's own preview widget) as our background. Waits for its natural size to be
  // known before committing, since a just-attached <video> may not have metadata yet.
  // `sizeOverride`, when given, is used instead of the element's own pixel size — needed
  // for video-preview elements that are a downscaled proxy of the real output frames.
  function attachMedia(el, source, sizeOverride, sizeConfirmed) {
    const sz = sizeOverride || mediaSize(el);
    if (!sz.w || !sz.h) {
      const evt = el.tagName === "VIDEO" ? "loadedmetadata" : "load";
      el.addEventListener(evt, () => attachMedia(el, source, sizeOverride, sizeConfirmed), { once: true });
      return;
    }
    watchVideo(el.tagName === "VIDEO" ? el : null);
    state.mediaEl = el;
    state.naturalWidth = sz.w;
    state.naturalHeight = sz.h;
    if (source === "own") {
      setStatus("Preview: last cropped output");
    } else if (sizeConfirmed === false) {
      setStatus("Preview: connected input (size unconfirmed — verify crop after a run)");
    } else {
      setStatus("Preview: connected input");
    }
    if (!state.autoFitDone && isDefaultRect()) {
      state.autoFitDone = true;
      setRect({ x: 0, y: 0, width: sz.w, height: sz.h });
    }
    drawCanvas();
  }

  function loadPreviewFromUrl(url, source) {
    if (!url) return false;
    const img = new Image();
    img.onload = () => attachMedia(img, source);
    img.src = url;
    return true;
  }

  // Async because resolving a video loader's *true* output size may need a network
  // round-trip (see resolveTrueVideoSize). `seq` guards against overlapping calls —
  // refreshPreview can be triggered again (new connection, execution, button click)
  // before an earlier call's fetch has resolved; only the latest call's result applies.
  let refreshSeq = 0;
  async function refreshPreview() {
    const seq = ++refreshSeq;
    const upstream = await resolveUpstreamPreview(node);
    if (seq !== refreshSeq) return;

    if (upstream?.el) {
      attachMedia(upstream.el, "upstream", upstream.sizeOverride, upstream.sizeConfirmed);
      return;
    }
    if (upstream?.url && loadPreviewFromUrl(upstream.url, "upstream")) return;

    const ownUrl = nodePreviewUrl(node);
    if (ownUrl && loadPreviewFromUrl(ownUrl, "own")) return;

    watchVideo(null);
    state.mediaEl = null;
    setStatus("No preview yet — connect an image/video or run once");
    drawCanvas();
  }

  for (const w of [xW, yW, wW, hW]) {
    const origCallback = w.callback;
    w.callback = function (...args) {
      const r = origCallback?.apply(this, args);
      state.autoFitDone = true;
      drawCanvas();
      return r;
    };
  }

  const origOnConnectionsChange = node.onConnectionsChange;
  node.onConnectionsChange = function (...args) {
    const r = origOnConnectionsChange?.apply(this, args);
    syncFromSource();
    setTimeout(refreshPreview, 50);
    return r;
  };

  // Cheap poll so a synced box visibly follows the upstream node's box as it's dragged,
  // without needing to hook into (and later unhook) that node's own widget callbacks.
  const syncPollInterval = setInterval(syncFromSource, 150);

  const origOnExecuted = node.onExecuted;
  node.onExecuted = function (...args) {
    const r = origOnExecuted?.apply(this, args);
    setTimeout(refreshPreview, 50);
    return r;
  };

  const origOnConfigure = node.onConfigure;
  node.onConfigure = function (...args) {
    const r = origOnConfigure?.apply(this, args);
    // A saved workflow already carries an explicit crop rect; never auto-fit over it.
    state.autoFitDone = true;
    setTimeout(refreshPreview, 50);
    return r;
  };

  const origOnResize = node.onResize;
  node.onResize = function (...args) {
    const r = origOnResize?.apply(this, args);
    drawCanvas();
    return r;
  };

  const origOnRemoved = node.onRemoved;
  node.onRemoved = function (...args) {
    watchVideo(null);
    clearInterval(syncPollInterval);
    return origOnRemoved?.apply(this, args);
  };

  syncFromSource();
  setTimeout(refreshPreview, 100);
  drawCanvas();
}
