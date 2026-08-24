import { app } from "../../scripts/app.js";

const NODE_NAME = "SimpleCrop";
const HANDLE_HIT = 10;
// Placeholder height before any media is loaded. Once a media size is known, the
// canvas's real pixel resolution and displayed size both track it exactly (no caps) —
// clamping either one independently is what caused the resize-blur and portrait-video
// aspect-ratio bugs.
const MIN_CANVAS_H = 160;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Place a crop rectangle from one image onto another of a different size. Mirrors
// map_crop_rect() in nodes.py — see that docstring for why the rectangle's shape is
// preserved instead of scaling each axis by its own fraction.
function mapRectAcross(rect, srcSize, dstSize) {
  const nx = rect.x / srcSize.w, ny = rect.y / srcSize.h;
  const nw = rect.width / srcSize.w, nh = rect.height / srcSize.h;
  if (!(nw > 0) || !(nh > 0)) return rect;

  const aspect = rect.width / rect.height;
  const byWidth = [nw * dstSize.w, (nw * dstSize.w) / aspect];
  const byHeight = [nh * dstSize.h * aspect, nh * dstSize.h];

  const fitting = [byWidth, byHeight].filter(
    (c) => c[0] <= dstSize.w + 0.5 && c[1] <= dstSize.h + 0.5);
  let boxW, boxH;
  if (fitting.length) {
    [boxW, boxH] = fitting.reduce((a, b) => (a[0] * a[1] >= b[0] * b[1] ? a : b));
  } else {
    const shrink = Math.min(dstSize.w / byWidth[0], dstSize.h / byWidth[1]);
    boxW = byWidth[0] * shrink;
    boxH = byWidth[1] * shrink;
  }

  const x = clamp((nx + nw / 2) * dstSize.w - boxW / 2, 0, dstSize.w - boxW);
  const y = clamp((ny + nh / 2) * dstSize.h - boxH / 2, 0, dstSize.h - boxH);
  return { x, y, width: boxW, height: boxH };
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

// The exact resolution the backend saw for this node's image input on its last run,
// reported back through the node's UI payload. Preview elements can disagree with it:
// a video decoder may emit codec-aligned frames (960x544 for a 960x540 video) that the
// browser only ever shows cropped to 960x540, which would skew the crop box slightly.
function executedSourceSize(node) {
  const s = app.nodeOutputs?.[node.id]?.simple_crop_source_size;
  if (!Array.isArray(s) || !(s[0] > 0) || !(s[1] > 0)) return null;
  return { w: s[0], h: s[1] };
}

// Only trust the reported size as a *refinement* of what the preview element itself
// reports. If they differ wildly the reported size is stale (the input was swapped
// since that run), so the element's own size is the safer basis.
function refineSize(reported, elementSize) {
  if (!reported) return null;
  if (!elementSize?.w || !elementSize?.h) return reported;
  const dw = Math.abs(reported.w - elementSize.w) / elementSize.w;
  const dh = Math.abs(reported.h - elementSize.h) / elementSize.h;
  return (dw <= 0.05 && dh <= 0.05) ? reported : null;
}

// Load a raw video file (e.g. core LoadVideo's uploaded source, served as-is via /view)
// and loop it, so the crop box can be judged against the motion rather than one frozen
// frame. Unlike VideoHelperSuite there is no downscaled proxy to borrow here, so this is
// the full-resolution file; /view serves HTTP range requests, so the browser streams it
// progressively instead of fetching the whole thing up front.
//
// Resolves once a frame is actually decoded (playing alone can leave the canvas blank),
// and times out rather than hanging refreshPreview if that never happens.
function tryLoadRawVideo(url) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.preload = "auto";
    // Marks this element as ours to pause and dispose of. A borrowed VideoHelperSuite
    // element must never be touched that way: its own node depends on it playing.
    v._simpleCropOwned = true;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    v.onerror = () => finish(null);
    v.onloadeddata = () => {
      // Autoplay is permitted for muted video, but a rejected play() must not stop us
      // from showing the frame we already have.
      Promise.resolve(v.play()).catch(() => {});
      finish(v);
    };
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
    // Once the box has been set deliberately — dragged, typed, or restored from a saved
    // workflow — it is never auto-fitted over again.
    userAdjusted: false,
    // Source size the box was last auto-fitted to, so a source that resolves late or in
    // stages (or gets swapped) re-fits instead of keeping a box sized for the old one.
    fittedTo: null,
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

    // Match the backend's placement exactly (see mapRectAcross).
    const srcSize = syncSourceNode._simpleCropSourceSize;
    let target = rect;
    if (srcSize?.w && srcSize?.h && state.naturalWidth && state.naturalHeight) {
      target = mapRectAcross(rect, srcSize,
                             { w: state.naturalWidth, h: state.naturalHeight });
    } else if (srcSize?.w && srcSize?.h) {
      // Our own preview hasn't resolved yet, so there's nothing to scale onto — leave
      // the box alone rather than showing a wrongly-scaled one. Execution is unaffected:
      // the backend rescales from crop_info regardless of what these widgets say.
      return;
    }

    // Compare against the clamped result, not the raw target: a target that clamps
    // (e.g. scaled slightly past the edge) would otherwise never compare equal and
    // would re-set + redraw on every poll tick.
    const cur = getRect();
    const next = clampRect(target);
    if (next.x !== cur.x || next.y !== cur.y ||
        next.width !== cur.width || next.height !== cur.height) {
      setRect(next);
    }
  }

  function clampRect(rect) {
    const nw = state.naturalWidth || 999999;
    const nh = state.naturalHeight || 999999;
    const x = clamp(Math.round(rect.x), 0, Math.max(0, nw - 1));
    const y = clamp(Math.round(rect.y), 0, Math.max(0, nh - 1));
    return {
      x, y,
      width: clamp(Math.round(rect.width), 1, nw - x),
      height: clamp(Math.round(rect.height), 1, nh - y),
    };
  }

  function setRect(rect) {
    const { x, y, width, height } = clampRect(rect);
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

    state.userAdjusted = true;
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

  // A video we created ourselves, as opposed to one borrowed from another node's preview
  // widget. Only our own may be paused or torn down.
  function isOwnVideo(el) {
    return !!el && el.tagName === "VIDEO" && el._simpleCropOwned;
  }

  function releaseVideo(el) {
    if (!isOwnVideo(el)) return;
    el.pause();
    // Drop the source so the browser stops buffering the file in the background.
    el.removeAttribute("src");
    el.load();
  }

  function watchVideo(el) {
    if (watchedVideoEl === el) return;
    if (watchedVideoEl) {
      watchedVideoEl.removeEventListener("timeupdate", onVideoTimeUpdate);
      releaseVideo(watchedVideoEl);
    }
    watchedVideoEl = el;
    if (watchedVideoEl) watchedVideoEl.addEventListener("timeupdate", onVideoTimeUpdate);
  }

  // Keep our own playback tied to whether the preview can actually be seen, so a graph
  // full of crop nodes isn't decoding video nobody is looking at.
  let previewVisible = true;
  function updatePlayback() {
    const el = state.mediaEl;
    if (!isOwnVideo(el) || !el.src) return;
    const shouldPlay = previewVisible && !document.hidden && !node.flags?.collapsed;
    if (shouldPlay && el.paused) Promise.resolve(el.play()).catch(() => {});
    else if (!shouldPlay && !el.paused) el.pause();
  }

  // Fail open. Under some hosts the observer never reports the widget as visible at all
  // (it is laid out at zero size, or never composited), and gating playback on that
  // would leave the preview permanently frozen. So only let it pause us once it has
  // actually reported visibility at least once.
  let observerEverSawVisible = false;
  const visibilityObserver = new IntersectionObserver((entries) => {
    const visible = entries.some((e) => e.isIntersecting);
    if (visible) observerEverSawVisible = true;
    previewVisible = visible || !observerEverSawVisible;
    updatePlayback();
  });
  visibilityObserver.observe(wrapper);
  document.addEventListener("visibilitychange", updatePlayback);

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
    // Published on the node itself so a downstream node syncing from this one can read
    // the resolution these pixel values are relative to (closures aren't reachable).
    node._simpleCropSourceSize = { w: sz.w, h: sz.h };
    if (source === "own") {
      setStatus("Preview: last cropped output");
    } else if (sizeConfirmed === false) {
      setStatus("Preview: connected input (size unconfirmed — verify crop after a run)");
    } else {
      setStatus("Preview: connected input");
    }
    // Fit the box to the whole source whenever the source size changes, unless the user
    // has set the box deliberately (or it is being driven by an upstream crop_info).
    const sizeChanged = !state.fittedTo || state.fittedTo.w !== sz.w || state.fittedTo.h !== sz.h;
    if (!state.userAdjusted && !syncSourceNode && sizeChanged) {
      state.fittedTo = { w: sz.w, h: sz.h };
      setRect({ x: 0, y: 0, width: sz.w, height: sz.h });
    }
    updatePlayback();
    drawCanvas();
  }

  function loadPreviewFromUrl(url, source, sizeOverride) {
    if (!url) return false;
    const img = new Image();
    img.onload = () => attachMedia(
      img, source, refineSize(sizeOverride, mediaSize(img)), sizeOverride ? true : undefined);
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
    if (seq !== refreshSeq) {
      // A newer call superseded this one. Any video it opened along the way would keep
      // streaming unnoticed, so shut it down here.
      releaseVideo(upstream?.el);
      return;
    }

    // Prefer the resolution the backend actually received on the last run over any
    // size inferred from a preview element or a metadata endpoint.
    const reported = executedSourceSize(node);

    if (upstream?.el) {
      // Compare against the size we would otherwise use, not the element's own pixels:
      // a VHS preview element is deliberately downscaled (e.g. 443x250 standing in for
      // 960x540), so it is not a valid reference for "is the reported size stale?".
      const baseline = upstream.sizeOverride || mediaSize(upstream.el);
      const exact = refineSize(reported, baseline);
      attachMedia(upstream.el, "upstream",
                  exact || upstream.sizeOverride,
                  exact ? true : upstream.sizeConfirmed);
      return;
    }
    if (upstream?.url && loadPreviewFromUrl(upstream.url, "upstream", reported)) return;

    // The node's own last output is the *cropped* result, so its dimensions are the
    // crop size — never the source size. Don't override it with `reported`.
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
      state.userAdjusted = true;
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
    state.userAdjusted = true;
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
    visibilityObserver.disconnect();
    document.removeEventListener("visibilitychange", updatePlayback);
    clearInterval(syncPollInterval);
    return origOnRemoved?.apply(this, args);
  };

  syncFromSource();
  setTimeout(refreshPreview, 100);
  drawCanvas();
}
