export type TripoBudget =
  | { unlimited: true }
  | {
      unlimited: false;
      maxCredits: number;
      imageStageCredits: number;
      modelStageCredits: number;
      maxScopeCredits?: number;
      cloudStageCredits?: number;
    };

export type BudgetSettings = {
  revision: string;
  budget: TripoBudget | null;
  invalid: boolean;
};

export type ConnectionSettings = {
  revision: string;
  region: 'global' | 'china';
  configured: boolean;
  readOnly: boolean;
};

export type TripoSettings = {
  connection: ConnectionSettings;
  budget: BudgetSettings | null;
  localConfiguration: boolean;
};
