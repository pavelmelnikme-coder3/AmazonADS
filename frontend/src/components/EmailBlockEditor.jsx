import { useState, useRef, useEffect } from "react";
import { DndContext, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { CSS as DndCSS } from "@dnd-kit/utilities";
import {
  GripVertical, Copy, Trash2, Image as ImageIcon, Type, MousePointer2,
  Bold, Italic, Underline, AlignLeft, AlignCenter, AlignRight,
  Plus, ChevronDown, SeparatorHorizontal, MoveVertical, Link as LinkIcon,
} from "lucide-react";
import { useI18n } from "../i18n/index.jsx";
import { newBlock } from "../lib/emailBlocks.js";
import UtmLinkBuilder from "./UtmLinkBuilder.jsx";

const Field = ({ label, children }) => (
  <div style={{ marginBottom: 8 }}>
    <label style={{ fontSize: 11, color: "var(--tx2)", display: "block", marginBottom: 3 }}>{label}</label>
    {children}
  </div>
);

const BLOCK_TYPES = [
  { type: "text", icon: Type, labelKey: "blockText" },
  { type: "image", icon: ImageIcon, labelKey: "blockImage" },
  { type: "button", icon: MousePointer2, labelKey: "blockButton" },
  { type: "divider", icon: SeparatorHorizontal, labelKey: "blockDivider" },
  { type: "spacer", icon: MoveVertical, labelKey: "blockSpacer" },
];

function ToolbarBtn({ icon: Icon, onClick, title }) {
  // onMouseDown preventDefault keeps focus (and the text selection) inside the
  // contentEditable div — otherwise clicking the button steals focus first and
  // execCommand loses the selection to apply formatting to.
  return (
    <button type="button" title={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick}
      className="btn btn-ghost" style={{ padding: "4px 7px", fontSize: 11 }}>
      <Icon size={13} />
    </button>
  );
}

// contentEditable is uncontrolled on purpose: React re-setting innerHTML on every
// keystroke resets the cursor position. innerHTML is written once (keyed by block.id,
// so a new block = a fresh mount) and synced out to state on blur/toolbar action only.
function TextBlockEditor({ block, onUpdate, onOpenUtm }) {
  const { t } = useI18n();
  const ref = useRef(null);
  const savedRange = useRef(null);

  useEffect(() => { if (ref.current) ref.current.innerHTML = block.html || ""; }, []);

  const sync = () => onUpdate({ html: ref.current?.innerHTML || "" });
  const exec = (cmd, val) => { ref.current?.focus(); document.execCommand(cmd, false, val); sync(); };

  // Root-cause fix for the original bug report: pasted content (e.g. a full
  // Word-exported HTML document with mso- cruft and a <style> block) is forced to
  // plain text, so it can never reintroduce class/style-block based rendering bugs.
  const handlePaste = (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData("text/plain");
    document.execCommand("insertText", false, text);
    sync();
  };

  const handleLink = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount) savedRange.current = sel.getRangeAt(0).cloneRange();
    onOpenUtm("", (finalUrl) => {
      const sel2 = window.getSelection();
      sel2.removeAllRanges();
      if (savedRange.current) sel2.addRange(savedRange.current);
      ref.current?.focus();
      document.execCommand("createLink", false, finalUrl);
      sync();
    });
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
        <ToolbarBtn icon={Bold} title={t("email.toolbarBold")} onClick={() => exec("bold")} />
        <ToolbarBtn icon={Italic} title={t("email.toolbarItalic")} onClick={() => exec("italic")} />
        <ToolbarBtn icon={Underline} title={t("email.toolbarUnderline")} onClick={() => exec("underline")} />
        <ToolbarBtn icon={AlignLeft} title={t("email.toolbarAlignLeft")} onClick={() => exec("justifyLeft")} />
        <ToolbarBtn icon={AlignCenter} title={t("email.toolbarAlignCenter")} onClick={() => exec("justifyCenter")} />
        <ToolbarBtn icon={AlignRight} title={t("email.toolbarAlignRight")} onClick={() => exec("justifyRight")} />
        <ToolbarBtn icon={LinkIcon} title={t("email.toolbarLink")} onClick={handleLink} />
      </div>
      <div ref={ref} contentEditable suppressContentEditableWarning onBlur={sync} onPaste={handlePaste}
        style={{ minHeight: 70, padding: 10, border: "1px solid var(--b2)", borderRadius: 7, background: "var(--s2)", fontSize: 14, lineHeight: 1.5, color: "var(--tx)" }} />
    </div>
  );
}

function ImageBlockEditor({ block, onUpdate, onOpenUtm, onUploadImage }) {
  const { t } = useI18n();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef(null);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true); setError("");
    try {
      const res = await onUploadImage(file);
      onUpdate({ src: res.url });
    } catch (err) {
      setError(err.message || t("email.uploadFailed"));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div>
      {block.src
        ? <img src={block.src} alt={block.alt || ""} style={{ maxWidth: "100%", maxHeight: 160, display: "block", marginBottom: 8, borderRadius: 6, border: "1px solid var(--b1)" }} />
        : <div style={{ padding: 24, textAlign: "center", color: "var(--tx3)", border: "1px dashed var(--b2)", borderRadius: 7, marginBottom: 8, fontSize: 12 }}>{t("email.imageUpload")}</div>}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={handleFile} disabled={uploading} style={{ fontSize: 12 }} />
        {uploading && <span style={{ fontSize: 11, color: "var(--tx3)" }}>{t("email.imageUploading")}</span>}
      </div>
      {error && <div style={{ color: "var(--red)", fontSize: 11, marginBottom: 8 }}>{error}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 100px", gap: 8 }}>
        <Field label={t("email.imageAlt")}><input value={block.alt || ""} onChange={(e) => onUpdate({ alt: e.target.value })} style={{ width: "100%" }} /></Field>
        <Field label={t("email.imageWidth")}><input type="number" value={block.width || 600} onChange={(e) => onUpdate({ width: e.target.value })} style={{ width: "100%" }} /></Field>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <select value={block.align || "center"} onChange={(e) => onUpdate({ align: e.target.value })} style={{ fontSize: 12 }}>
          <option value="left">{t("email.alignLeft")}</option>
          <option value="center">{t("email.alignCenter")}</option>
          <option value="right">{t("email.alignRight")}</option>
        </select>
        <button type="button" className="btn btn-ghost" style={{ fontSize: 11 }}
          onClick={() => onOpenUtm(block.link || "", (url) => onUpdate({ link: url }))}>
          <LinkIcon size={12} /> {block.link ? "✓ " : ""}{t("email.imageLink")}
        </button>
      </div>
    </div>
  );
}

function ButtonBlockEditor({ block, onUpdate, onOpenUtm }) {
  const { t } = useI18n();
  return (
    <div>
      <Field label={t("email.buttonText")}><input value={block.text || ""} onChange={(e) => onUpdate({ text: e.target.value })} style={{ width: "100%" }} /></Field>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, minWidth: 0 }}>
        {/* minWidth:0 on both this row and the text div below: a flex item's default
            min-width is `auto`, which for nowrap text resolves to its full unwrapped
            width — overflow:hidden/textOverflow:ellipsis alone don't override that, so a
            long UTM-tagged URL (common after HTML import) silently blew out this block,
            its column, and the whole composer modal instead of truncating. */}
        <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: block.link ? "var(--tx)" : "var(--tx3)", fontFamily: "var(--mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {block.link || t("email.buttonLink")}
        </div>
        <button type="button" className="btn btn-ghost" style={{ fontSize: 11, flexShrink: 0 }}
          onClick={() => onOpenUtm(block.link || "", (url) => onUpdate({ link: url }))}>
          <LinkIcon size={12} /> {t("email.buttonLink")}
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
        <Field label={t("email.buttonColor")}><input type="color" value={block.bgColor || "#2563EB"} onChange={(e) => onUpdate({ bgColor: e.target.value })} style={{ width: "100%", padding: 2, height: 30 }} /></Field>
        <Field label={t("email.buttonTextColor")}><input type="color" value={block.textColor || "#ffffff"} onChange={(e) => onUpdate({ textColor: e.target.value })} style={{ width: "100%", padding: 2, height: 30 }} /></Field>
        <Field label={t("email.buttonRadius")}><input type="number" min={0} value={block.radius ?? 6} onChange={(e) => onUpdate({ radius: e.target.value })} style={{ width: "100%" }} /></Field>
        <Field label={t("email.imageAlign")}>
          <select value={block.align || "center"} onChange={(e) => onUpdate({ align: e.target.value })} style={{ width: "100%" }}>
            <option value="left">{t("email.alignLeft")}</option>
            <option value="center">{t("email.alignCenter")}</option>
            <option value="right">{t("email.alignRight")}</option>
          </select>
        </Field>
      </div>
    </div>
  );
}

function DividerBlockEditor({ block, onUpdate }) {
  const { t } = useI18n();
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
      <Field label={t("email.dividerColor")}><input type="color" value={block.color || "#e2e8f0"} onChange={(e) => onUpdate({ color: e.target.value })} style={{ width: "100%", padding: 2, height: 30 }} /></Field>
      <Field label={t("email.dividerThickness")}><input type="number" min={1} value={block.thickness ?? 1} onChange={(e) => onUpdate({ thickness: e.target.value })} style={{ width: "100%" }} /></Field>
      <Field label={t("email.spacerHeight")}><input type="number" min={0} value={block.marginY ?? 16} onChange={(e) => onUpdate({ marginY: e.target.value })} style={{ width: "100%" }} /></Field>
    </div>
  );
}

function SpacerBlockEditor({ block, onUpdate }) {
  const { t } = useI18n();
  return <Field label={t("email.spacerHeight")}><input type="number" min={0} value={block.height ?? 24} onChange={(e) => onUpdate({ height: e.target.value })} style={{ width: 120 }} /></Field>;
}

const BLOCK_EDITORS = { text: TextBlockEditor, image: ImageBlockEditor, button: ButtonBlockEditor, divider: DividerBlockEditor, spacer: SpacerBlockEditor };

// Mirrors the existing SortableRule/SortableKeyword pattern used elsewhere in the app.
function SortableBlock({ id, children }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = { transform: DndCSS.Transform.toString(transform), transition, opacity: isDragging ? 0.45 : 1, position: "relative", zIndex: isDragging ? 10 : undefined };
  return <div ref={setNodeRef} style={style}>{children({ dragHandleProps: { ...listeners, ...attributes } })}</div>;
}

function BlockRow({ block, dragHandleProps, onUpdate, onDuplicate, onDelete, onOpenUtm, onUploadImage }) {
  const { t } = useI18n();
  const Editor = BLOCK_EDITORS[block.type];
  const typeInfo = BLOCK_TYPES.find((b) => b.type === block.type);
  return (
    <div style={{ background: "var(--s1)", border: "1px solid var(--b1)", borderRadius: 10, padding: 12, marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--tx3)", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>
          <span {...dragHandleProps} title={t("email.blockDrag")} style={{ cursor: "grab", display: "flex" }}><GripVertical size={14} /></span>
          {typeInfo && <typeInfo.icon size={13} />}
          {t(`email.${typeInfo?.labelKey}`)}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <button type="button" title={t("email.blockDuplicate")} className="btn btn-ghost" style={{ padding: "3px 6px" }} onClick={onDuplicate}><Copy size={12} /></button>
          <button type="button" title={t("email.blockDelete")} className="btn btn-ghost" style={{ padding: "3px 6px" }} onClick={onDelete}><Trash2 size={12} /></button>
        </div>
      </div>
      {Editor && <Editor block={block} onUpdate={onUpdate} onOpenUtm={onOpenUtm} onUploadImage={onUploadImage} />}
    </div>
  );
}

/**
 * @param {Array} blocks - flat list of content blocks (composer.content_blocks.blocks)
 * @param {(blocks: Array) => void} onChange
 * @param {string} campaignName - used to prefill the UTM builder's default utm_campaign
 * @param {(file: File) => Promise<{url:string}>} onUploadImage
 */
export default function EmailBlockEditor({ blocks, onChange, campaignName, onUploadImage }) {
  const { t } = useI18n();
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [utmModal, setUtmModal] = useState(null); // { initialUrl, onApply } | null

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const updateBlock = (id, patch) => onChange(blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  const duplicateBlock = (id) => {
    const idx = blocks.findIndex((b) => b.id === id);
    if (idx < 0) return;
    const copy = { ...blocks[idx], id: crypto.randomUUID ? crypto.randomUUID() : `${blocks[idx].id}-copy-${Date.now()}` };
    onChange([...blocks.slice(0, idx + 1), copy, ...blocks.slice(idx + 1)]);
  };
  const deleteBlock = (id) => {
    if (!window.confirm(t("email.blockDeleteConfirm"))) return;
    onChange(blocks.filter((b) => b.id !== id));
  };
  const addBlock = (type) => { onChange([...blocks, newBlock(type)]); setAddMenuOpen(false); };
  const openUtm = (initialUrl, onApply) => setUtmModal({ initialUrl, onApply });

  const handleDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    const oldIndex = blocks.findIndex((b) => b.id === active.id);
    const newIndex = blocks.findIndex((b) => b.id === over.id);
    onChange(arrayMove(blocks, oldIndex, newIndex));
  };

  return (
    <div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={blocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
          {blocks.map((b) => (
            <SortableBlock key={b.id} id={b.id}>
              {({ dragHandleProps }) => (
                <BlockRow block={b} dragHandleProps={dragHandleProps}
                  onUpdate={(patch) => updateBlock(b.id, patch)}
                  onDuplicate={() => duplicateBlock(b.id)}
                  onDelete={() => deleteBlock(b.id)}
                  onOpenUtm={openUtm}
                  onUploadImage={onUploadImage} />
              )}
            </SortableBlock>
          ))}
        </SortableContext>
      </DndContext>

      {!blocks.length && (
        <div style={{ padding: 24, textAlign: "center", color: "var(--tx3)", border: "1px dashed var(--b2)", borderRadius: 10, marginBottom: 10, fontSize: 13 }}>
          {t("email.addBlock")}
        </div>
      )}

      <div style={{ position: "relative" }}>
        <button type="button" className="btn btn-ghost" style={{ fontSize: 12, width: "100%", justifyContent: "center" }} onClick={() => setAddMenuOpen((v) => !v)}>
          <Plus size={13} /> {t("email.addBlock")} <ChevronDown size={13} />
        </button>
        {addMenuOpen && (
          <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, background: "var(--s1)", border: "1px solid var(--b1)", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,.3)", zIndex: 20, overflow: "hidden" }}>
            {BLOCK_TYPES.map(({ type, icon: Icon, labelKey }) => (
              <button key={type} type="button" onClick={() => addBlock(type)}
                style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "9px 12px", background: "transparent", border: "none", color: "var(--tx)", fontSize: 13, cursor: "pointer", textAlign: "left" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--s2)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                <Icon size={14} /> {t(`email.${labelKey}`)}
              </button>
            ))}
          </div>
        )}
      </div>

      <UtmLinkBuilder open={!!utmModal} initialUrl={utmModal?.initialUrl} campaignName={campaignName}
        onApply={(url) => utmModal?.onApply(url)} onClose={() => setUtmModal(null)} />
    </div>
  );
}
