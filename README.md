# ComfyUI Simple Crop

A crop node you operate by dragging a box on the node itself. `IMAGE` in,
`IMAGE` out, and the same node handles a single image or a whole video frame
batch.

The preview appears as soon as you connect a source, so you can set the crop
without running the workflow first.

![Basic operation](demo/tips01.gif)

## Usage

1. Connect any `IMAGE` output into `Simple Crop`.
2. Drag the corners, edges, or inside of the box to set the region, or type
   exact `x` / `y` / `width` / `height` values below the preview.
3. Send the `IMAGE` output wherever you need it: `SaveImage`, VideoHelperSuite's
   `Video Combine`, an upscaler, a sampler, and so on.

After a run, the node's preview switches to the cropped result so you can check
the framing at a glance.

### Where this is useful

When you build a test pipeline around a reference video (layout, previs, a
render pass you're driving something with), the part you actually care about is
often a small region of the frame. Rendering layers separately, or feeding one
object to a model, usually means cropping in and scaling that object up so it
reads clearly.

Doing that in an editor means leaving ComfyUI, re-cutting, re-exporting, and
coming back every time the framing changes. This keeps it in the graph, and you
can see the crop while you set it.

![Syncing a crop to the first frame](demo/tips02.gif)

### Keeping a still in sync with the video

A reference video is often paired with a separately rendered first frame. Both
need the same framing, or they don't describe the same shot.

Connect the video crop node's `crop_info` output into the still's `crop_info`
input. The second node then mirrors the first live, and its `x` / `y` /
`width` / `height` become read-only. Disconnect to edit it again.

The two sources rarely match in size. A 1920x1080 video next to a 1024x848
render is normal. The rectangle is transferred as a proportion and keeps its
aspect ratio, so both crops come out the same shape, positioned equivalently,
rather than reusing raw pixel numbers that would frame different regions.

An example graph covering both halves is in
[`example_workflow/`](example_workflow/SimpleCrop_demoWorkflow.json).

## Install

Copy (or clone) this folder into ComfyUI's `custom_nodes/`, then restart
ComfyUI. No extra Python dependencies.

## Notes

- **Video input:** two ways in, both with a moving preview. VideoHelperSuite's
  `Load Video` connects straight to this node. ComfyUI's built-in `Load Video`
  needs a `Get Video Components` node in between. The preview pauses when the
  node is collapsed or the tab is in the background.
- **Swapping a source file** on an upstream loader doesn't refresh the preview
  automatically. Press **Refresh preview** on the crop node.
- **Odd output heights:** some videos decode a few pixels taller than their
  stated size (960x544 for a 960x540 file). The node crops what it is actually
  given, and the preview corrects itself after one run.
- **Syncing matches the box, not the subject.** If the object sits at a
  different size or place in your two sources to begin with, the synced box
  won't magically line it up, so expect to nudge one side. `Image Compare` or
  `Image Blend` (difference mode) help you check.

## Reference

- [ComfyUI-VideoHelperSuite](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite)
  for the video preview.
- [ComfyUI-KJNodes](https://github.com/kijai/ComfyUI-KJNodes) `Image Transform`
  for the on-canvas crop box.

---

MIT License
