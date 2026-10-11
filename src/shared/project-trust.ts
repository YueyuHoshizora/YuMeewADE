export type ProjectTrustState = 'unreviewed' | 'trusted' | 'restricted';
export interface ProjectTrustView {
  state: ProjectTrustState;
  rootChanged: boolean;
  root: string;
  cwd: string;
  user: string;
  revision: string;
  fullAccess: Record<string, boolean>;
  overrides: Partial<Record<string, boolean>>;
  additionalDirectories: string[];
  reviewReadonly: true;
}
export interface ProjectTrustPatch {
  state: ProjectTrustState;
  overrides: Partial<Record<string, boolean>>;
  revision: string;
  confirmed: boolean;
}
