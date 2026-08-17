"use client";

import { ArrowUpRight, Check, CheckCircle2, ImagePlus, LoaderCircle, RotateCcw, ShieldAlert, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";

type IssueType = "bug" | "feature" | "question" | "compatibility";

type SelectedImage = {
  file: File;
  url: string;
};

type DraftResponse = {
  draftId: string;
  expiresAt: number;
  preview: {
    type: IssueType;
    title: string;
    summary: string;
    body: string;
  };
  rateLimit: {
    remaining: number;
    resetAt: number;
  };
};

type SubmitResponse = {
  issueNumber: number;
  issueUrl: string;
};

const copy = {
  cn: {
    draftStep: "问题描述",
    previewStep: "Issue 预览",
    descriptionLabel: "发生了什么？",
    descriptionHint: "建议包含：你做了什么、看到了什么、期望怎样。版本和环境不知道也没关系，不要猜。",
    descriptionPlaceholder: "例如：macOS 上连接 PostgreSQL 后，展开 schema 一直转圈，没有错误提示。重启和重新连接都试过了。",
    attachments: "截图（可选）",
    attachmentHint: "点击添加、拖入或直接粘贴截图。支持 PNG、JPEG 和 WebP，最多 3 张，单张不超过 5 MB。",
    addImages: "添加截图",
    generate: "整理为 Issue 草稿",
    generateAgain: "重新整理",
    generating: "正在整理",
    type: "类型",
    titleLabel: "标题",
    bodyLabel: "GitHub 正文",
    bodyHint: "可以自由修改。最终提交时会在末尾追加图片和匿名来源说明。",
    summary: "整理摘要",
    confirm: "我已检查标题、正文和截图，并理解这些内容将公开显示在 GitHub。",
    submit: "确认并公开创建 Issue",
    submitting: "正在创建 Issue",
    publicWarning: "提交前请确认",
    publicNotice: "请勿上传密码、Token、连接串、未脱敏 IP、客户或隐私数据；提交后 Issue 和图片将公开可见。",
    successTitle: "Issue 已创建",
    successText: (number: number) => `GitHub Issue #${number} 已创建。后续进展会公开记录在该页面。`,
    openIssue: "查看 GitHub Issue",
    another: "再提交一个",
    removeImage: "移除图片",
    errors: {
      DESCRIPTION_REQUIRED: "请先填写问题描述。",
      DESCRIPTION_TOO_SHORT: "描述至少需要 4 个字符。",
      DESCRIPTION_TOO_LONG: "描述过长，请控制在 6000 字符以内。",
      TOO_MANY_IMAGES: "最多只能上传 3 张图片。",
      IMAGE_TOO_LARGE: "单张图片不能超过 5 MB。",
      IMAGES_TOO_LARGE: "图片总大小不能超过 12 MB。",
      IMAGE_TYPE_UNSUPPORTED: "仅支持真实的 PNG、JPEG 或 WebP 图片。",
      RATE_LIMITED: "生成草稿过于频繁，请稍后再试。",
      AI_NOT_CONFIGURED: "AI 草稿服务尚未配置，请联系维护者。",
      AI_REQUEST_FAILED: "AI 服务暂时不可用，请稍后重试。",
      AI_REQUEST_TIMEOUT: "截图分析时间较长，请重试；如果仍然超时，可以减少截图数量。",
      AI_RESPONSE_INVALID: "AI 返回的草稿格式异常，请重新生成。",
      DRAFT_EXPIRED: "草稿已过期，请重新生成。",
      DRAFT_SUBMITTING: "这个草稿正在提交，请不要重复点击。",
      DRAFT_IMAGES_CHANGED: "草稿生成后截图发生变化，请重新生成草稿。",
      ISSUE_SESSION_EXPIRED: "临时会话已过期，请重新生成草稿。",
      GITHUB_ISSUE_CREATE_FAILED: "GitHub 暂时未能创建 Issue，请稍后重试。",
      ISSUE_IMAGE_UPLOAD_FAILED: "截图上传失败，请稍后重试。",
      ISSUE_REQUEST_FAILED: "提交失败，请稍后重试。",
    },
    genericError: "请求失败，请稍后重试。",
    clientImageError: "仅支持 PNG、JPEG 或 WebP，最多 3 张，单张不超过 5 MB。",
    retryAfter: (minutes: number) => `大约 ${minutes} 分钟后可再次生成。`,
  },
  en: {
    draftStep: "Describe the issue",
    previewStep: "Issue preview",
    descriptionLabel: "What happened?",
    descriptionHint: "Include what you did, what you saw, and what you expected. If you do not know a version or environment detail, do not guess.",
    descriptionPlaceholder: "Example: On macOS, expanding a PostgreSQL schema keeps loading without an error. Restarting and reconnecting did not help.",
    attachments: "Screenshots (optional)",
    attachmentHint: "Choose, drag, or paste screenshots here. PNG, JPEG, or WebP; up to 3 images and 5 MB each.",
    addImages: "Add screenshots",
    generate: "Prepare Issue draft",
    generateAgain: "Prepare again",
    generating: "Preparing draft",
    type: "Type",
    titleLabel: "Title",
    bodyLabel: "GitHub body",
    bodyHint: "Fully editable. Images and an anonymous-source note are appended when submitted.",
    summary: "Draft summary",
    confirm: "I reviewed the title, body, and screenshots and understand that they will be publicly visible on GitHub.",
    submit: "Confirm and create public Issue",
    submitting: "Creating Issue",
    publicWarning: "Before submitting",
    publicNotice: "Do not upload passwords, tokens, connection strings, unredacted IPs, customer data, or personal data. The Issue and images will be public.",
    successTitle: "Issue created",
    successText: (number: number) => `GitHub Issue #${number} was created. Follow-up progress will be recorded on that public page.`,
    openIssue: "Open GitHub Issue",
    another: "Submit another",
    removeImage: "Remove image",
    errors: {
      DESCRIPTION_REQUIRED: "Describe the problem first.",
      DESCRIPTION_TOO_SHORT: "The description must contain at least 4 characters.",
      DESCRIPTION_TOO_LONG: "Keep the description under 6,000 characters.",
      TOO_MANY_IMAGES: "You can upload up to 3 images.",
      IMAGE_TOO_LARGE: "Each image must be 5 MB or smaller.",
      IMAGES_TOO_LARGE: "Images must be 12 MB or smaller in total.",
      IMAGE_TYPE_UNSUPPORTED: "Only real PNG, JPEG, and WebP images are supported.",
      RATE_LIMITED: "Too many draft attempts. Please try again later.",
      AI_NOT_CONFIGURED: "The AI drafting service has not been configured yet.",
      AI_REQUEST_FAILED: "The AI service is temporarily unavailable. Try again later.",
      AI_REQUEST_TIMEOUT: "Screenshot analysis took too long. Try again, or attach fewer screenshots.",
      AI_RESPONSE_INVALID: "The AI returned an invalid draft. Generate it again.",
      DRAFT_EXPIRED: "This draft expired. Generate a new one.",
      DRAFT_SUBMITTING: "This draft is already being submitted.",
      DRAFT_IMAGES_CHANGED: "The screenshots changed after drafting. Generate the draft again.",
      ISSUE_SESSION_EXPIRED: "The temporary session expired. Generate the draft again.",
      GITHUB_ISSUE_CREATE_FAILED: "GitHub could not create the Issue. Try again later.",
      ISSUE_IMAGE_UPLOAD_FAILED: "The screenshots could not be uploaded. Try again later.",
      ISSUE_REQUEST_FAILED: "Submission failed. Try again later.",
    },
    genericError: "The request failed. Try again later.",
    clientImageError: "Use up to 3 PNG, JPEG, or WebP images, no more than 5 MB each.",
    retryAfter: (minutes: number) => `Try again in about ${minutes} minutes.`,
  },
};

const issuePrefixes: Record<IssueType, string> = {
  bug: "[Bug]",
  feature: "[Feature]",
  question: "[Question]",
  compatibility: "[Compatibility]",
};

function responseErrorMessage(lang: "cn" | "en", code: string, retryAfter?: number): string {
  const t = copy[lang];
  const base = t.errors[code as keyof typeof t.errors] ?? t.genericError;
  if (code !== "RATE_LIMITED" || !retryAfter) return base;
  return `${base} ${t.retryAfter(Math.max(1, Math.ceil(retryAfter / 60)))}`;
}

export function IssueSubmissionClient({ lang }: { lang: "cn" | "en" }) {
  const t = copy[lang];
  const [description, setDescription] = useState("");
  const [images, setImages] = useState<SelectedImage[]>([]);
  const [draftId, setDraftId] = useState("");
  const [draftExpiresAt, setDraftExpiresAt] = useState(0);
  const [issueType, setIssueType] = useState<IssueType>("bug");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [summary, setSummary] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState<"draft" | "submit" | null>(null);
  const [draggingImages, setDraggingImages] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState<SubmitResponse | null>(null);
  const imagesRef = useRef<SelectedImage[]>([]);

  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  useEffect(() => {
    return () => imagesRef.current.forEach((image) => URL.revokeObjectURL(image.url));
  }, []);

  function clearDraft() {
    setDraftId("");
    setDraftExpiresAt(0);
    setTitle("");
    setBody("");
    setSummary("");
    setConfirmed(false);
    setSuccess(null);
  }

  function changeDescription(value: string) {
    setDescription(value);
    if (draftId) clearDraft();
    setError("");
  }

  function addImages(files: FileList | File[] | null) {
    if (!files) return;
    const candidates = Array.from(files);
    if (candidates.length === 0) return;
    const valid = candidates.every((file) => ["image/png", "image/jpeg", "image/webp"].includes(file.type) && file.size <= 5 * 1024 * 1024);
    const totalBytes = [...images.map((image) => image.file), ...candidates].reduce((total, file) => total + file.size, 0);
    if (!valid || images.length + candidates.length > 3 || totalBytes > 12 * 1024 * 1024) {
      setError(t.clientImageError);
      return;
    }
    if (draftId) clearDraft();
    setImages((current) => [...current, ...candidates.map((file) => ({ file, url: URL.createObjectURL(file) }))]);
    setError("");
  }

  function pasteImages(event: ClipboardEvent<HTMLDivElement>) {
    const pastedImages = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (pastedImages.length === 0) return;
    event.preventDefault();
    addImages(pastedImages);
  }

  function dropImages(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDraggingImages(false);
    addImages(event.dataTransfer.files);
  }

  function removeImage(index: number) {
    if (draftId) clearDraft();
    setImages((current) => {
      const target = current[index];
      if (target) URL.revokeObjectURL(target.url);
      return current.filter((_, currentIndex) => currentIndex !== index);
    });
  }

  function changeIssueType(nextType: IssueType) {
    const withoutPrefix = title.replace(/^\[(?:Bug|Feature|Question|Compatibility)]\s*/i, "").trim();
    setIssueType(nextType);
    setTitle(`${issuePrefixes[nextType]} ${withoutPrefix}`.trim());
    setConfirmed(false);
  }

  async function parseResponse<T>(response: Response): Promise<T> {
    let data: Record<string, unknown> = {};
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      data = {};
    }
    if (!response.ok) {
      const code = typeof data.error === "string" ? data.error : "ISSUE_REQUEST_FAILED";
      const retryAfter = typeof data.retryAfter === "number" ? data.retryAfter : undefined;
      throw new Error(responseErrorMessage(lang, code, retryAfter));
    }
    return data as T;
  }

  async function generateDraft() {
    setLoading("draft");
    setError("");
    setSuccess(null);
    const form = new FormData();
    form.set("description", description);
    form.set("language", lang);
    images.forEach((image) => form.append("images", image.file));
    try {
      const response = await fetch("/api/issues/draft", { method: "POST", body: form });
      const data = await parseResponse<DraftResponse>(response);
      setDraftId(data.draftId);
      setDraftExpiresAt(data.expiresAt);
      setIssueType(data.preview.type);
      setTitle(data.preview.title);
      setBody(data.preview.body);
      setSummary(data.preview.summary);
      setConfirmed(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t.genericError);
    } finally {
      setLoading(null);
    }
  }

  async function submitIssue() {
    if (!draftId || !confirmed) return;
    if (draftExpiresAt <= Date.now()) {
      setError(responseErrorMessage(lang, "DRAFT_EXPIRED"));
      return;
    }
    setLoading("submit");
    setError("");
    const form = new FormData();
    form.set("draftId", draftId);
    form.set("type", issueType);
    form.set("title", title);
    form.set("body", body);
    images.forEach((image) => form.append("images", image.file));
    try {
      const response = await fetch("/api/issues/submit", { method: "POST", body: form });
      setSuccess(await parseResponse<SubmitResponse>(response));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t.genericError);
    } finally {
      setLoading(null);
    }
  }

  function resetForm() {
    images.forEach((image) => URL.revokeObjectURL(image.url));
    setDescription("");
    setImages([]);
    clearDraft();
    setError("");
  }

  if (success) {
    return (
      <section className="issue-shell issue-success-shell">
        <div className="issue-success-card">
          <span className="issue-success-icon"><CheckCircle2 size={30} /></span>
          <h1>{t.successTitle}</h1>
          <p>{t.successText(success.issueNumber)}</p>
          <div className="issue-success-actions">
            <a href={success.issueUrl} target="_blank" rel="noopener noreferrer" className="issue-primary-button">
              {t.openIssue}<ArrowUpRight size={17} />
            </a>
            <button type="button" className="issue-secondary-button" onClick={resetForm}>
              <RotateCcw size={16} />{t.another}
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="issue-shell">
      <div className="issue-layout">
        <div className="issue-workbench" onPaste={pasteImages}>
          <section className="issue-public-note">
            <div className="issue-warning-heading"><ShieldAlert size={15} /><strong>{t.publicWarning}</strong></div>
            <p>{t.publicNotice}</p>
          </section>

          <section className="issue-panel">
            <div className="issue-panel-heading">
              <span className="issue-step-number">1</span>
              <h1>{t.draftStep}</h1>
            </div>

            <label className="issue-field">
              <span>{t.descriptionLabel}</span>
              <small>{t.descriptionHint}</small>
              <textarea value={description} onChange={(event) => changeDescription(event.target.value)} placeholder={t.descriptionPlaceholder} maxLength={6000} rows={7} disabled={loading !== null} />
              <em>{description.length} / 6000</em>
            </label>

            <div
              className={`issue-upload-block${draggingImages ? " is-dragging" : ""}`}
              onDragEnter={(event) => { event.preventDefault(); setDraggingImages(true); }}
              onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDraggingImages(true); }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingImages(false);
              }}
              onDrop={dropImages}
            >
              <div><strong>{t.attachments}</strong><small>{t.attachmentHint}</small></div>
              {images.length > 0 && (
                <div className="issue-image-grid">
                  {images.map((image, index) => (
                    <div className="issue-image-preview" key={`${image.file.name}-${image.file.lastModified}-${index}`}>
                      <img src={image.url} alt={image.file.name} />
                      <button type="button" onClick={() => removeImage(index)} aria-label={t.removeImage} disabled={loading !== null}><X size={15} /></button>
                      <span>{Math.max(1, Math.round(image.file.size / 1024))} KB</span>
                    </div>
                  ))}
                </div>
              )}
              {images.length < 3 && (
                <label className="issue-upload-button">
                  <ImagePlus size={17} />{t.addImages}
                  <input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(event) => { addImages(event.target.files); event.currentTarget.value = ""; }} disabled={loading !== null} />
                </label>
              )}
            </div>

            <div className="issue-action-row">
              <button type="button" className="issue-primary-button" onClick={generateDraft} disabled={loading !== null || description.trim().length < 4}>
                {loading === "draft" ? <LoaderCircle className="issue-spinner" size={18} /> : <Sparkles size={18} />}
                {loading === "draft" ? t.generating : draftId ? t.generateAgain : t.generate}
              </button>
            </div>
          </section>

          {draftId && (
            <section className="issue-panel issue-preview-panel">
              <div className="issue-panel-heading">
                <span className="issue-step-number">2</span>
                <h2>{t.previewStep}</h2>
              </div>
              <div className="issue-ai-summary"><Sparkles size={16} /><p>{summary}</p></div>
              <div className="issue-preview-grid">
                <label className="issue-field issue-type-field">
                  <span>{t.type}</span>
                  <select value={issueType} onChange={(event) => changeIssueType(event.target.value as IssueType)} disabled={loading !== null}>
                    <option value="bug">Bug</option>
                    <option value="feature">Feature</option>
                    <option value="question">Question</option>
                    <option value="compatibility">Compatibility</option>
                  </select>
                </label>
                <label className="issue-field issue-title-field">
                  <span>{t.titleLabel}</span>
                  <input value={title} onChange={(event) => { setTitle(event.target.value); setConfirmed(false); }} maxLength={160} disabled={loading !== null} />
                </label>
              </div>
              <label className="issue-field">
                <span>{t.bodyLabel}</span>
                <small>{t.bodyHint}</small>
                <textarea className="issue-body-editor" value={body} onChange={(event) => { setBody(event.target.value); setConfirmed(false); }} maxLength={12000} rows={18} disabled={loading !== null} />
                <em>{body.length} / 12000</em>
              </label>
              <label className="issue-confirm-row">
                <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={loading !== null} />
                <span aria-hidden="true"><Check size={14} /></span>
                <p>{t.confirm}</p>
              </label>
              <button type="button" className="issue-submit-button" onClick={submitIssue} disabled={!confirmed || loading !== null || title.trim().length < 8 || body.trim().length < 20}>
                {loading === "submit" ? <LoaderCircle className="issue-spinner" size={18} /> : <ArrowUpRight size={18} />}
                {loading === "submit" ? t.submitting : t.submit}
              </button>
            </section>
          )}

          {error && <div className="issue-error" role="alert"><ShieldAlert size={18} /><span>{error}</span></div>}
        </div>
      </div>
    </section>
  );
}
