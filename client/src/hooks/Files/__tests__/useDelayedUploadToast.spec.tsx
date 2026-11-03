import { act, renderHook } from '@testing-library/react';
import { useDelayedUploadToast } from '../useDelayedUploadToast';

const mockShowToast = jest.fn();
jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: mockShowToast }),
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

describe('delayed upload warning', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('allows progress callbacks captured before the upload starts to cancel its warning', () => {
    const { result } = renderHook(() => useDelayedUploadToast());
    const clearFromRequest = result.current.clearUploadTimer;
    act(() => result.current.startUploadTimer('file', 'scan.pdf', 10));
    act(() => clearFromRequest('file'));
    act(() => jest.advanceTimersByTime(60_000));
    expect(mockShowToast).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('only cancels the matching file and clears remaining timers on unmount', () => {
    const { result, unmount } = renderHook(() => useDelayedUploadToast());
    act(() => {
      result.current.startUploadTimer('first', 'first.pdf', 10);
      result.current.startUploadTimer('second', 'second.pdf', 10);
      result.current.clearUploadTimer('first');
      jest.advanceTimersByTime(5_000);
    });
    expect(mockShowToast).toHaveBeenCalledTimes(1);
    act(() => result.current.startUploadTimer('third', 'third.pdf', 10));
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });
});
