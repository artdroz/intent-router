export type GateConfig = {
  learningEnabled: boolean;
};

export type GateClass = {
  id: number;
  label: string;
  description?: string;
  utterances: string[];
  keywords: string[];
};

export type Gate = {
  id: number;
  tenantId: string | null;
  name: string;
  description: string | null;
  config: GateConfig;
  classes: GateClass[];
  createdAt: Date;
  updatedAt: Date;
};
