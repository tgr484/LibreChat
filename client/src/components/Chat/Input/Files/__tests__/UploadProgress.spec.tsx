import { Provider, createStore } from 'jotai';
import userEvent from '@testing-library/user-event';
import { act, render, screen } from '@testing-library/react';
import type { TOCRProgress } from 'librechat-data-provider';
import { updateUploadProgressAtom } from '~/hooks/Files/progress';
import UploadProgress from '../UploadProgress';

const progress: TOCRProgress = {
  status: 'recognizing',
  page_unit: 'pdf_page',
  page_count: 12,
  pages_done: 3,
  figures_total: 2,
  figures_done: 1,
  position: null,
  retry_rounds: 0,
  retry_at: null,
};

describe('attachment OCR progress', () => {
  const setup = () => {
    const store = createStore();
    store.set(updateUploadProgressAtom, { type: 'start', fileId: 'first' });
    store.set(updateUploadProgressAtom, { type: 'start', fileId: 'second' });
    render(
      <Provider store={store}>
        <UploadProgress fileId="first">
          {(subtitle, processing) => (
            <div data-testid="first" data-processing={processing}>
              {subtitle ?? 'PDF document'}
            </div>
          )}
        </UploadProgress>
        <UploadProgress fileId="second">
          {(subtitle) => <div data-testid="second">{subtitle ?? 'Second document'}</div>}
        </UploadProgress>
      </Provider>,
    );
    const update = (ocr: TOCRProgress | null) =>
      act(() => {
        store.set(updateUploadProgressAtom, { type: 'update', fileId: 'first', ocr });
      });
    return { store, update };
  };

  it('shows each upload independently and reflects decreasing counters during retries', async () => {
    const { update } = setup();
    update(progress);
    expect(screen.getByRole('status')).toHaveTextContent('Recognizing: 3 of 12');
    expect(screen.getByTestId('first')).toHaveAttribute('data-processing', 'true');
    expect(screen.getByTestId('second')).toHaveTextContent('Second document');

    update({ ...progress, pages_done: 1, retry_rounds: 1 });
    expect(screen.getByRole('status')).toHaveTextContent('Recognizing: 1 of 12');
    const anchor = screen.getByTestId('first').parentElement;
    expect(anchor).toHaveAttribute('tabindex', '0');
    await userEvent.tab();
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Pages: 1 of 12');
    expect(tooltip).toHaveTextContent('Figures: 1 of 2');
    expect(tooltip).toHaveTextContent('Retry rounds: 1');
  });

  it.each([
    ['pdf_page', 'Pages'],
    ['djvu_page', 'Pages'],
    ['section', 'Sections'],
    ['slide', 'Slides'],
    ['sheet', 'Sheets'],
    ['future_unit', 'Items'],
  ])('uses %s as %s in the details', async (pageUnit, label) => {
    const { update } = setup();
    update({ ...progress, page_unit: pageUnit });
    await userEvent.tab();
    expect(await screen.findByRole('tooltip')).toHaveTextContent(`${label}: 3 of 12`);
  });

  it('shows unknown totals without percentages and keeps OCR done in a processing state', async () => {
    const { update } = setup();
    update({ ...progress, status: 'queued', page_count: 0, position: 4 });
    expect(screen.getByRole('status')).toHaveTextContent('Queued for recognition');
    await userEvent.tab();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Queue position: 4');
    expect(screen.getByRole('status')).not.toHaveTextContent('%');
    update({ ...progress, status: 'done' });
    expect(screen.getByRole('status')).toHaveTextContent('Finishing processing');
    expect(screen.getByTestId('first')).toHaveAttribute('data-processing', 'true');
  });

  it('resets to ordinary processing and ignores late updates after removal', () => {
    const { store, update } = setup();
    update(progress);
    update(null);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByTestId('first')).toHaveTextContent('PDF document');
    act(() => store.set(updateUploadProgressAtom, { type: 'clear', fileId: 'first' }));
    update(progress);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
