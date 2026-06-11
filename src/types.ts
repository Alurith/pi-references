export type ReferenceConfigValue = string | LocalReferenceConfig | GitReferenceConfig;

export type ReferencesConfigFile = {
  references?: Record<string, ReferenceConfigValue>;
};

export type LocalReferenceConfig = {
  path: string;
  description?: string;
  hidden?: boolean;
};

export type GitReferenceConfig = {
  repository: string;
  branch?: string;
  description?: string;
  hidden?: boolean;
};

export type ReferenceSourceType = "global" | "project";

export type ResolvedReference = {
  alias: string;
  kind: "local" | "git";
  hidden: boolean;
  description?: string;
  sourceConfigPath: string;
  sourceType: ReferenceSourceType;
  declaredPath?: string;
  repository?: string;
  branch?: string;
  resolvedPath?: string;
  error?: string;
};
