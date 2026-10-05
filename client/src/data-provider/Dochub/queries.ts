import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { PermissionBits, QueryKeys, dataService } from 'librechat-data-provider';
import type {
  AgentListResponse,
  TDochubPublishParams,
  TDochubPublishResponse,
  TDochubCollectionsResponse,
} from 'librechat-data-provider';
import type { QueryObserverResult, UseQueryOptions } from '@tanstack/react-query';

/** Collections the user can build a DocHub agent on, straight from DocHub. */
export const useDochubCollectionsQuery = (
  config?: UseQueryOptions<TDochubCollectionsResponse>,
): QueryObserverResult<TDochubCollectionsResponse> =>
  useQuery<TDochubCollectionsResponse>(
    [QueryKeys.dochubCollections],
    () => dataService.getDochubCollections(),
    {
      retry: false,
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      ...config,
    },
  );

/** DocHub agents the user may edit; one page is plenty for a personal list. */
export const useDochubAgentsQuery = (
  config?: UseQueryOptions<AgentListResponse>,
): QueryObserverResult<AgentListResponse> =>
  useQuery<AgentListResponse>(
    [QueryKeys.dochubAgents],
    () =>
      dataService.getMarketplaceAgents({
        requiredPermission: PermissionBits.EDIT,
        dochub: 1,
        limit: 100,
      }),
    {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      ...config,
    },
  );

/** Publishes a collection (or, with `dryRun`, reports what publishing would change). */
export const usePublishDochubCollectionMutation = () => {
  const queryClient = useQueryClient();
  return useMutation<TDochubPublishResponse, unknown, TDochubPublishParams>(
    (params) => dataService.publishDochubCollection(params),
    {
      onSuccess: (_data, params) => {
        if (params.dryRun !== true) {
          queryClient.invalidateQueries([QueryKeys.dochubCollections]);
        }
      },
    },
  );
};
