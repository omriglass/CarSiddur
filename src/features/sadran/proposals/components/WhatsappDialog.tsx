import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { he, tv } from "@/i18n/he";
import { showErrorToast } from "@/lib/rpc";
import { buildWaUrl } from "../waLink";

/** Keep preparation in the app; WhatsApp itself requires an explicit external handoff. */
export function WhatsappDialog({ name, phone, message }: { name: string; phone: string; message: string }) {
  const [text, setText] = useState(message);
  return (
    <Dialog onOpenChange={(open) => { if (open) setText(message); }}>
      <DialogTrigger asChild>
        <Button variant="outline" className="w-full">{tv("sadranProposal.sendWhatsapp", { name })}</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{he.whatsappDialog.title}</DialogTitle>
          <DialogDescription>{tv("whatsappDialog.recipient", { name })}</DialogDescription>
        </DialogHeader>
        <Textarea aria-label={he.whatsappDialog.title} value={text} onChange={(e) => setText(e.target.value)} rows={8} />
        <p className="text-sm text-muted-foreground">{he.whatsappDialog.help}</p>
        <DialogFooter className="sticky bottom-0 flex-wrap gap-2 bg-background py-2">
          <DialogClose asChild><Button variant="outline" className="min-h-11">{he.whatsappDialog.close}</Button></DialogClose>
          <Button variant="outline" onClick={() => void navigator.clipboard.writeText(text).then(() => toast.success(he.whatsappDialog.copied)).catch(showErrorToast)}>{he.whatsappDialog.copy}</Button>
          <Button asChild><a href={buildWaUrl(phone, text)}>{he.whatsappDialog.handoff}</a></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
