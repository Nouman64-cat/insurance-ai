import api from "./api";

const tenantId = () => (typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "");

/** The standard document types offered when uploading — kept in step with the upload dialogs. */
export const DOCUMENT_TYPES = [
  "CNIC", "Salary Slip", "Medical Report", "X-Ray", "MRI Scan", "Bank Statement", "Tax Return",
  "Policy Form", "Claim Form", "Child's Birth Certificate", "Other",
];

/** A fresh, short-lived link to the stored file. */
export async function getArtifactUrl(artifactId: string): Promise<string> {
  const res = await api.get<{ download_url: string }>(`/tenants/${tenantId()}/artifacts/${artifactId}`);
  return res.data.download_url;
}

/** Change a document's type (what requirement it counts toward) and/or its display name. */
export async function updateArtifact(artifactId: string, body: { document_type?: string; file_name?: string }) {
  const res = await api.patch(`/tenants/${tenantId()}/artifacts/${artifactId}`, body);
  return res.data;
}

/** Remove the file from storage and the case; requirements it satisfied revert to Missing. */
export async function deleteArtifact(artifactId: string): Promise<void> {
  await api.delete(`/tenants/${tenantId()}/artifacts/${artifactId}`);
}
