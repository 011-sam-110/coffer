// One-time code from a QR code (SPEC 6, tier 2): read one on the screen, or
// in an image file that Rust asks for with its own dialog.
import { ImageUp, ScanQrCode } from "lucide-react";
import { useState } from "react";
import { call, isCofferError } from "../lib/ipc";
import { qrErrorText } from "../lib/tier2Errors";
import { Button } from "./ui";

export function QrScanButtons({ onUri }: { onUri: (uri: string) => void }) {
  const [busy, setBusy] = useState<"screen" | "file" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const read = async (source: "screen" | "file") => {
    setBusy(source);
    setErr(null);
    try {
      const r = await call("totp_from_image", { source });
      if (r) onUri(r.uri); // null: the file dialog was cancelled
    } catch (e) {
      setErr(isCofferError(e) ? qrErrorText(e, source) : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      {/* Each button sits 6 px into the gutter, so the two line up when they wrap. */}
      <div className="flex flex-wrap gap-x-3">
        <Button size="sm" variant="ghost" className="-ml-1.5 px-1.5" icon={<ScanQrCode className="size-3.5" />} loading={busy === "screen"} disabled={!!busy} onClick={() => read("screen")}>
          Scan QR code on screen
        </Button>
        <Button size="sm" variant="ghost" className="-ml-1.5 px-1.5" icon={<ImageUp className="size-3.5" />} loading={busy === "file"} disabled={!!busy} onClick={() => read("file")}>
          Choose QR image...
        </Button>
      </div>
      {err && (
        <p role="alert" className="text-xs text-danger-text">
          {err}
        </p>
      )}
    </div>
  );
}
