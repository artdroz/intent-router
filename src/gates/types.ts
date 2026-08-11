export type GateConfig = {
  learningEnabled: boolean;
};

export type GateClass = {
  label: string;
  description?: string;
  utterances: string[];
  keywords: string[];
  promotedKeywords: string[];
};

export type Gate = {
  id: number;
  name: string;
  description: string | null;
  config: GateConfig;
  classes: GateClass[];
  createdAt: Date;
  updatedAt: Date;
};
