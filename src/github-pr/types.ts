export type Capability =
  | {
      available: true;
      hostname: string;
      repo: string;
      owner: string;
      repository: string;
    }
  | {
      available: false;
      reason: string;
    };

export interface PullRequest {
  number: number;
  title?: string;
  body?: string;
  url?: string;
  state?: string;
  isDraft?: boolean;
  author?: { login?: string };
  baseRefName?: string;
  headRefName?: string;
  reviewDecision?: string | null;
  createdAt?: string;
  updatedAt?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  mergeable?: string;
  mergeStateStatus?: string;
}
