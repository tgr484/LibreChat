import { useState } from 'react';
import { Share2Icon } from 'lucide-react';
import {
  Permissions,
  SystemRoles,
  ResourceType,
  PermissionBits,
  PermissionTypes,
} from 'librechat-data-provider';
import {
  Label,
  Button,
  Spinner,
  OGDialog,
  OGDialogTrigger,
  OGDialogTemplate,
  useToastContext,
} from '@librechat/client';
import type { Agent, TDochubCollection, TDochubPublishResponse } from 'librechat-data-provider';
import { useLocalize, useAuthContext, useHasAccess, useResourcePermissions } from '~/hooks';
import { usePublishDochubCollectionMutation } from '~/data-provider';
import { GenericGrantAccessDialog } from '~/components/Sharing';
import { dochubErrorKey } from './errors';

/**
 * Sharing a DocHub agent: the regular share dialog, but only once its
 * collection is public — otherwise recipients could not use the agent. Until
 * then the button opens a warning with what publishing will change, and
 * publishing is what unlocks the share dialog.
 */
export default function ShareDochubAgent({
  agent,
  collection,
}: {
  agent: Pick<Agent, '_id' | 'id' | 'name' | 'author'>;
  collection?: TDochubCollection;
}) {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const { showToast } = useToastContext();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<TDochubPublishResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const publish = usePublishDochubCollectionMutation();

  const hasAccessToShare = useHasAccess({
    permissionType: PermissionTypes.AGENTS,
    permission: Permissions.SHARE,
  });
  const { hasPermission, isLoading } = useResourcePermissions(ResourceType.AGENT, agent._id ?? '');
  const isAdmin = user?.role === SystemRoles.ADMIN;
  const canShare =
    (agent.author === user?.id || isAdmin || hasPermission(PermissionBits.SHARE)) &&
    (hasAccessToShare || isAdmin);

  if (!canShare || isLoading || !agent._id || !collection) {
    return null;
  }

  if (collection.is_public === true) {
    return (
      <GenericGrantAccessDialog
        resourceDbId={agent._id}
        resourceId={agent.id}
        resourceName={agent.name ?? ''}
        resourceType={ResourceType.AGENT}
      />
    );
  }

  const canPublish = collection.role !== 'viewer';

  const loadPreview = () => {
    setPreview(null);
    setPreviewError(null);
    publish.mutate(
      { collectionId: collection.id, dryRun: true },
      {
        onSuccess: setPreview,
        onError: (error) => setPreviewError(localize(dochubErrorKey(error))),
      },
    );
  };

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next && canPublish) {
      loadPreview();
    }
  };

  const confirm = () =>
    publish.mutate(
      { collectionId: collection.id },
      {
        onSuccess: () =>
          showToast({
            message: localize('com_ui_dochub_published', { name: collection.name }),
            status: 'success',
          }),
        onError: (error) =>
          showToast({ message: localize(dochubErrorKey(error)), status: 'error' }),
      },
    );

  const renderBody = () => {
    if (!canPublish) {
      return localize('com_ui_dochub_share_not_manager', { name: collection.name });
    }
    if (previewError) {
      return previewError;
    }
    if (!preview) {
      return (
        <span role="status" aria-label={localize('com_ui_loading')}>
          <Spinner className="h-4 w-4" />
        </span>
      );
    }
    return (
      <>
        <p>{localize('com_ui_dochub_share_warning', { name: collection.name })}</p>
        {preview.made_public > 0 && (
          <p className="mt-2">
            {localize('com_ui_dochub_share_made_public', { count: preview.made_public })}
          </p>
        )}
        {preview.removed_private > 0 && (
          <p className="mt-2">
            {localize('com_ui_dochub_share_removed_private', { count: preview.removed_private })}
          </p>
        )}
      </>
    );
  };

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          type="button"
          aria-label={localize('com_ui_share')}
          title={localize('com_ui_share')}
        >
          <Share2Icon className="h-4 w-4" aria-hidden="true" />
        </Button>
      </OGDialogTrigger>
      <OGDialogTemplate
        title={localize('com_ui_dochub_share_title')}
        className="max-w-[480px]"
        main={
          <Label className="text-left text-sm font-normal leading-relaxed text-text-primary">
            {renderBody()}
          </Label>
        }
        selection={
          canPublish && preview && !previewError
            ? {
                selectHandler: confirm,
                selectText: localize('com_ui_dochub_share_confirm'),
              }
            : undefined
        }
      />
    </OGDialog>
  );
}
