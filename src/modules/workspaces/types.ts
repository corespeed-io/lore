export interface WorkspaceSummary {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
  createdAt: string;
  updatedAt: string;
}
