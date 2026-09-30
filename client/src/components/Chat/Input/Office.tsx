import React, { memo } from 'react';
import { FileText } from 'lucide-react';
import { CheckboxButton } from '@librechat/client';
import { useBadgeRowContext } from '~/Providers';
import { badgeAccents } from './accents';
import { useLocalize } from '~/hooks';

function Office() {
  const localize = useLocalize();
  const context = useBadgeRowContext();
  const { toggleState: officeActive, debouncedChange, isPinned } = context?.office ?? {};

  return (
    (officeActive || isPinned) && (
      <CheckboxButton
        checked={officeActive}
        setValue={debouncedChange}
        label={localize('com_ui_office_docs')}
        isCheckedClassName={badgeAccents.blue}
        icon={<FileText className="icon-md" aria-hidden="true" />}
      />
    )
  );
}

export default memo(Office);
