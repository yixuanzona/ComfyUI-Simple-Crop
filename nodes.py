from comfy_api.latest import io, ui

# Carries a crop rectangle from one Simple Crop node to another (e.g. to keep a video
# crop and a separately rendered first-frame crop framed the same way) over a single
# connection instead of four INT sockets.
#
# The rectangle travels NORMALIZED (0-1 fractions of the source's size) plus the source's
# pixel dimensions, because the two sides routinely differ — a 1920x1080 video paired with
# a 1024x848 render. Raw pixel values would frame a different region on each.
CropInfo = io.Custom("SIMPLE_CROP_INFO")


def map_crop_rect(crop_info, target_w: int, target_h: int):
    """Place an incoming crop rectangle onto an image of a different size.

    Scaling each axis by its own fraction only works when both sides share an aspect
    ratio. They often don't (16:9 video vs a 1.21:1 render), and independent scaling
    then reshapes the box — a landscape 1248x1080 video crop turns into a portrait
    666x848 one, framing something else entirely.

    So the rectangle's own shape is preserved and placed at the proportionally
    equivalent centre. Of the two ways to size it — matching the source's width
    fraction or its height fraction — the larger one that still fits is used, which
    keeps whichever edge the crop was pushed up against: a full-height crop stays
    full-height, a full-width crop stays full-width.
    """
    nx, ny = crop_info["x"], crop_info["y"]
    nw, nh = crop_info["width"], crop_info["height"]
    src_w = crop_info.get("source_width") or 0
    src_h = crop_info.get("source_height") or 0

    # Without the source's pixel size the rectangle's true shape is unknowable; fall
    # back to plain per-axis scaling.
    if not src_w or not src_h or nw <= 0 or nh <= 0:
        return (round(nx * target_w), round(ny * target_h),
                round(nw * target_w), round(nh * target_h))

    aspect = (nw * src_w) / (nh * src_h)
    by_width = (nw * target_w, nw * target_w / aspect)
    by_height = (nh * target_h * aspect, nh * target_h)

    fitting = [c for c in (by_width, by_height)
               if c[0] <= target_w + 0.5 and c[1] <= target_h + 0.5]
    if fitting:
        box_w, box_h = max(fitting, key=lambda c: c[0] * c[1])
    else:
        shrink = min(target_w / by_width[0], target_h / by_width[1])
        box_w, box_h = by_width[0] * shrink, by_width[1] * shrink

    # Centre it proportionally, then nudge it back inside rather than resizing it.
    x = (nx + nw / 2) * target_w - box_w / 2
    y = (ny + nh / 2) * target_h - box_h / 2
    x = max(0.0, min(x, target_w - box_w))
    y = max(0.0, min(y, target_h - box_h))
    return round(x), round(y), round(box_w), round(box_h)


class SimpleCrop(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SimpleCrop",
            display_name="Simple Crop",
            category="image/transform",
            description=(
                "Crop an image or an image batch (video frame sequence) to a "
                "rectangle. Drag the box on the node's preview to set the region, "
                "or type exact pixel values. Connect crop_info from another Simple "
                "Crop node to reuse its rectangle instead."
            ),
            is_output_node=True,
            inputs=[
                io.Image.Input("image", tooltip="Image or batch of frames to crop."),
                io.Int.Input("x", default=0, min=0, max=999999, step=1,
                             tooltip="Crop box left edge, in pixels."),
                io.Int.Input("y", default=0, min=0, max=999999, step=1,
                             tooltip="Crop box top edge, in pixels."),
                io.Int.Input("width", default=512, min=1, max=999999, step=1,
                             tooltip="Crop box width, in pixels."),
                io.Int.Input("height", default=512, min=1, max=999999, step=1,
                             tooltip="Crop box height, in pixels."),
                CropInfo.Input(
                    "crop_info", optional=True,
                    tooltip="Optional: reuse the crop rectangle from another Simple "
                            "Crop node's crop_info output instead of x/y/width/height."
                ),
            ],
            outputs=[
                io.Image.Output("IMAGE"),
                CropInfo.Output("crop_info"),
            ],
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo],
        )

    @classmethod
    def execute(cls, image, x: int, y: int, width: int, height: int, crop_info=None) -> io.NodeOutput:
        _b, h, w, _c = image.shape

        if crop_info is not None:
            x, y, width, height = map_crop_rect(crop_info, w, h)

        x0 = max(0, min(int(x), w - 1))
        y0 = max(0, min(int(y), h - 1))
        x1 = max(x0 + 1, min(x0 + int(width), w))
        y1 = max(y0 + 1, min(y0 + int(height), h))

        cropped = image[:, y0:y1, x0:x1, :]
        used_rect = {
            "x": x0 / w,
            "y": y0 / h,
            "width": (x1 - x0) / w,
            "height": (y1 - y0) / h,
            "source_width": w,
            "source_height": h,
        }

        # Only preview the first frame: for a video-length batch, previewing every
        # frame would render a whole filmstrip under the node. The full batch is
        # still returned as the actual data output below.
        payload = ui.PreviewImage(cropped[:1], cls=cls).as_dict()
        # Report the resolution actually received, so the UI can draw the crop box
        # against the real tensor rather than a guess. These can disagree: a decoder
        # may hand over a codec-aligned frame (e.g. 960x544 for a video whose display
        # size is 960x540), which the browser never shows.
        payload["simple_crop_source_size"] = [w, h]
        return io.NodeOutput(cropped, used_rect, ui=payload)
