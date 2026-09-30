import { useMemo } from 'react';
import type { TDochubCollection } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks/useLocalize';
import { useLocalize } from '~/hooks';

const SECTION_LABELS: Record<TDochubCollection['section'], TranslationKeys> = {
  my: 'com_ui_dochub_section_my',
  shared_with_me: 'com_ui_dochub_section_shared',
  public: 'com_ui_dochub_section_public',
};

const SECTIONS = Object.keys(SECTION_LABELS) as TDochubCollection['section'][];

export default function CollectionSelect({
  id,
  value,
  collections,
  disabled,
  onChange,
}: {
  id: string;
  value: number | null;
  collections: TDochubCollection[];
  disabled?: boolean;
  onChange: (collection: TDochubCollection) => void;
}) {
  const localize = useLocalize();

  const bySection = useMemo(() => {
    const groups = new Map<TDochubCollection['section'], TDochubCollection[]>();
    for (const collection of collections) {
      groups.set(collection.section, [...(groups.get(collection.section) ?? []), collection]);
    }
    return groups;
  }, [collections]);

  const byId = useMemo(
    () => new Map(collections.map((collection) => [collection.id, collection])),
    [collections],
  );

  return (
    <select
      id={id}
      value={value ?? ''}
      disabled={disabled}
      onChange={(event) => {
        const selected = byId.get(Number(event.target.value));
        if (selected) {
          onChange(selected);
        }
      }}
      className="h-9 w-full rounded-lg border border-border-light bg-surface-secondary px-2 text-sm text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary disabled:opacity-50"
    >
      <option value="" disabled>
        {localize('com_ui_dochub_select_collection')}
      </option>
      {SECTIONS.map((section) => {
        const items = bySection.get(section);
        if (!items?.length) {
          return null;
        }
        return (
          <optgroup key={section} label={localize(SECTION_LABELS[section])}>
            {items.map((collection) => (
              <option key={collection.id} value={collection.id}>
                {collection.is_public === true && section !== 'public'
                  ? `${collection.name} · ${localize('com_ui_dochub_public_mark')}`
                  : collection.name}
                {` (${collection.document_count})`}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}
