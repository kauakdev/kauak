import { MAX_BANNER_BYTES, validateBanner } from "../../../shared/plugins/registry";
import type { BrandBanner } from "../../../shared/plugins/contracts";

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
/** Rasterize to a bounded local PNG. Never persist URLs, SVG or executable resources. */
export async function prepareBanner(file: File, anchorId: string): Promise<BrandBanner> {
  if (!file.size || file.size > MAX_UPLOAD_BYTES) throw new Error("Choose an image smaller than 4 MB.");
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("Choose a PNG, JPEG or WebP image. SVG is not supported.");
  const url = URL.createObjectURL(file);
  try {
    const img = await decodeImage(url);
    if (img.naturalWidth > 8192 || img.naturalHeight > 8192 || img.naturalWidth * img.naturalHeight > 24_000_000)
      throw new Error("This image is too large to process. Resize it to at most 8192 pixels per side and 24 megapixels.");
    const scale = Math.min(1, 1600 / img.naturalWidth, 800 / img.naturalHeight);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("This browser cannot process the image. Try another browser.");
    let outputScale = scale;
    // Detailed images can exceed the storage budget even within the dimension
    // limit. Redraw from the original at a smaller size, keeping PNG alpha.
    for (let attempt = 0; attempt < 8; attempt++) {
      canvas.width = Math.max(1, Math.round(img.naturalWidth * outputScale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * outputScale));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/png");
      if (dataUrl.length <= MAX_BANNER_BYTES)
        return validateBanner({ dataUrl, name: file.name.slice(0, 120) || "Company banner", width: canvas.width, height: canvas.height, anchorId, visible: true });
      outputScale *= Math.min(0.9, Math.sqrt(MAX_BANNER_BYTES / dataUrl.length) * 0.95);
    }
    throw new Error("This image could not be resized for local storage. Choose another image.");
  } finally { URL.revokeObjectURL(url); }
}
export async function decodeImage(src: string): Promise<HTMLImageElement> {
  const img = new Image(); img.src = src;
  try { await img.decode(); } catch { throw new Error("The image could not be read. Choose another PNG, JPEG or WebP file."); }
  if (!img.naturalWidth || !img.naturalHeight) throw new Error("This image is empty. Choose another file.");
  return img;
}
