import type { DochubErrorKind } from './types';

/**
 * Failure modes of the DocHub integration API, per §7 of its contract, plus the
 * transport-level ones. `retryable` follows the contract's "what the client
 * should do" column — it never means "retry blindly", the client decides how
 * many times and how long to wait.
 */
export class DochubError extends Error {
  readonly kind: DochubErrorKind;
  readonly status?: number;
  readonly detail?: string;
  readonly retryable: boolean;

  constructor(params: {
    kind: DochubErrorKind;
    message: string;
    status?: number;
    detail?: string;
    retryable?: boolean;
  }) {
    super(params.message);
    this.name = 'DochubError';
    this.kind = params.kind;
    this.status = params.status;
    this.detail = params.detail;
    this.retryable = params.retryable ?? RETRYABLE_KINDS.has(params.kind);
  }
}

const RETRYABLE_KINDS: ReadonlySet<DochubErrorKind> = new Set<DochubErrorKind>([
  'auth',
  'rate_limited',
  'ask_slot_busy',
  'ldap_unavailable',
  'server',
  'network',
  'timeout',
]);

/** `detail` values that carry more meaning than the status code alone. */
const DETAIL_KINDS: Readonly<Record<string, DochubErrorKind>> = {
  invalid_token: 'auth',
  forbidden: 'forbidden',
  account_conflict: 'account_conflict',
  collection_not_found: 'collection_not_found',
  not_found: 'not_found',
  version_mismatch: 'version_mismatch',
  rate_limited: 'rate_limited',
  ask_slot_busy: 'ask_slot_busy',
  ldap_unavailable: 'ldap_unavailable',
  integration_misconfigured: 'misconfigured',
};

const STATUS_KINDS: Readonly<Record<number, DochubErrorKind>> = {
  401: 'auth',
  403: 'forbidden',
  404: 'integration_off',
  409: 'version_mismatch',
  422: 'bad_request',
  429: 'rate_limited',
  500: 'server',
  503: 'ldap_unavailable',
};

/**
 * `404 Not Found` (the framework's own body) means the route is absent or the
 * integration is switched off in DocHub — a different situation from
 * `not_found`, which means this document is not readable by this user.
 */
export function classifyResponse(status: number, detail: string | undefined): DochubErrorKind {
  const byDetail = detail != null ? DETAIL_KINDS[detail] : undefined;
  if (byDetail != null) {
    return byDetail;
  }
  return STATUS_KINDS[status] ?? (status >= 500 ? 'server' : 'bad_request');
}

export function errorFromResponse(params: {
  status: number;
  detail?: string;
  route: string;
}): DochubError {
  const kind = classifyResponse(params.status, params.detail);
  return new DochubError({
    kind,
    status: params.status,
    detail: params.detail,
    message: `DocHub ${params.route} → ${params.status} ${params.detail ?? ''}`.trim(),
  });
}

/** Anything thrown by the transport (axios, abort, DNS) becomes a `DochubError`. */
export function mapDochubError(error: unknown, route: string): DochubError {
  if (error instanceof DochubError) {
    return error;
  }
  const candidate = error as { code?: string; name?: string; message?: string } | undefined;
  const code = candidate?.code;
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
    return new DochubError({
      kind: 'timeout',
      message: `DocHub ${route} → timeout`,
    });
  }
  if (candidate?.name === 'AbortError' || code === 'ERR_CANCELED') {
    return new DochubError({
      kind: 'aborted',
      message: `DocHub ${route} → aborted`,
      retryable: false,
    });
  }
  return new DochubError({
    kind: 'network',
    message: `DocHub ${route} → ${candidate?.message ?? 'network error'}`,
  });
}

/**
 * What the chat model is told. Russian, short, and always actionable: the model
 * decides on its own whether to try another collection, fall back to a summary
 * or tell the user the material is unavailable.
 */
const MODEL_MESSAGES: Readonly<Record<DochubErrorKind, string>> = {
  auth: 'Не удалось пройти аутентификацию в DocHub — это ошибка настройки интеграции. Сообщи пользователю, что DocHub сейчас недоступен, и не повторяй вызов.',
  forbidden:
    'У пользователя нет доступа к этой коллекции или к DocHub. Сообщи об этом пользователю.',
  account_conflict:
    'Учётная запись пользователя в DocHub не создана — нужен администратор DocHub. Сообщи об этом пользователю.',
  integration_off:
    'Интеграция с DocHub сейчас выключена на стороне DocHub. Сообщи пользователю, что материалы недоступны.',
  collection_not_found: 'Такой коллекции в DocHub нет. Вызови dochub и выбери коллекцию из списка.',
  not_found:
    'Документ недоступен для чтения. Если он входит в коллекцию, попробуй получить только выжимку.',
  version_mismatch:
    'Документ изменился во время чтения. Повтори вызов, чтобы прочитать его заново.',
  bad_request: 'Некорректные параметры вызова. Исправь их и повтори — без изменений не повторяй.',
  rate_limited:
    'Превышен лимит обращений к DocHub. Сократи число вызовов и используй уже полученные данные.',
  ask_slot_busy:
    'Поиск DocHub занят другим запросом этого пользователя. Повтори поиск чуть позже или опирайся на уже найденное.',
  ldap_unavailable:
    'Служба каталога временно недоступна, DocHub не может проверить права. Повтори позже.',
  misconfigured:
    'DocHub не может прочитать ключи интеграции — нужен администратор. Не повторяй вызов.',
  server: 'DocHub ответил ошибкой. Повтори позже или опирайся на уже полученные данные.',
  network: 'Не удалось связаться с DocHub. Повтори позже.',
  timeout: 'DocHub не ответил вовремя. Повтори позже или сузь запрос.',
  aborted: 'Вызов к DocHub прерван — продолжай с тем, что уже получено.',
  budget: 'Исчерпан бюджет одного вызова инструмента. Сузь вопрос или разбей задачу на части.',
};

export function describeForModel(error: DochubError): string {
  return MODEL_MESSAGES[error.kind];
}
