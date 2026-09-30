/** A DocHub collection as the «Агенты DocHub» builder sees it. */
export type TDochubCollection = {
  id: number;
  name: string;
  description: string | null;
  document_count: number;
  owner_username?: string;
  /** `null` when DocHub is too old to say; treated as not public. */
  is_public: boolean | null;
  role: 'owner' | 'coauthor' | 'viewer';
  section: 'my' | 'shared_with_me' | 'public';
};

export type TDochubCollectionsResponse = {
  collections: TDochubCollection[];
};

/** What publishing a collection changes (or, with `dryRun`, would change). */
export type TDochubPublishResponse = {
  id: number;
  is_public: boolean;
  made_public: number;
  removed_private: number;
};

export type TDochubPublishParams = {
  collectionId: number;
  dryRun?: boolean;
};

/** Error codes the DocHub agent routes answer with, for the client to localize. */
export type TDochubErrorCode =
  | 'dochub_not_configured'
  | 'dochub_not_ldap'
  | 'dochub_no_identity'
  | 'dochub_collection_unavailable'
  | 'dochub_collection_private'
  | 'dochub_collection_locked'
  | 'dochub_not_manager'
  | 'dochub_publish_unsupported'
  | 'dochub_unavailable';
