const ATTACHMENT_REFERENCE_PREFIX = "fortnote-attachment:";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function formatAttachmentReference(attachmentId: string): string {
  if (!UUID_PATTERN.test(attachmentId)) {
    throw new Error("Invalid attachment id");
  }
  return `${ATTACHMENT_REFERENCE_PREFIX}${attachmentId}`;
}

export function parseAttachmentReference(url: string): string | null {
  if (!url.startsWith(ATTACHMENT_REFERENCE_PREFIX)) {
    return null;
  }
  const attachmentId = url.slice(ATTACHMENT_REFERENCE_PREFIX.length);
  if (!UUID_PATTERN.test(attachmentId)) {
    throw new Error("Invalid Fortnote attachment reference");
  }
  return attachmentId;
}

export function isAttachmentMimeCompatible(
  mimeType: string,
  acceptedMimeTypes: readonly string[]
): boolean {
  const normalizedMimeType = mimeType.toLowerCase();
  return (
    acceptedMimeTypes.length === 0 ||
    acceptedMimeTypes.some((accepted) => {
      const normalizedAccepted = accepted.toLowerCase();
      return (
        normalizedAccepted === "*/*" ||
        normalizedAccepted === normalizedMimeType ||
        (normalizedAccepted.endsWith("/*") &&
          normalizedMimeType.startsWith(normalizedAccepted.slice(0, -1)))
      );
    })
  );
}
