import type { ErrorTranslations } from '@aura/plugin-sdk/errors';

const locales = ['zh-CN', 'en', 'ja', 'ko', 'ru', 'fr'] as const;
type TranslationRow = readonly [string, string, string, string, string, string];
const messages = {
  invalidInput: [
    'Tripo 输入无效，请检查必填字段与参数。',
    'Tripo input is invalid. Check the required fields and parameters.',
    'Tripo の入力が無効です。必須項目とパラメーターを確認してください。',
    'Tripo 입력이 올바르지 않습니다. 필수 항목과 매개변수를 확인해 주세요.',
    'Недопустимые входные данные Tripo. Проверьте обязательные поля и параметры.',
    'Les données Tripo sont invalides. Vérifiez les champs requis et les paramètres.',
  ],
  unsupportedOperation: [
    'Tripo 不支持此操作。',
    'Tripo does not support this operation.',
    'Tripo はこの操作に対応していません。',
    'Tripo는 이 작업을 지원하지 않습니다.',
    'Tripo не поддерживает эту операцию.',
    'Tripo ne prend pas en charge cette opération.',
  ],
  keyMissing: [
    'Tripo 尚未配置 API Key。',
    'No Tripo API key is configured.',
    'Tripo の API キーが設定されていません。',
    'Tripo API 키가 설정되지 않았습니다.',
    'API-ключ Tripo не настроен.',
    'Aucune clé API Tripo n’est configurée.',
  ],
  keyInvalid: [
    'Tripo 凭据无效，请更新 Tripo 配置后重试。',
    'Tripo credentials are invalid. Update the Tripo configuration before retrying.',
    'Tripo の認証情報が無効です。設定を更新してから再試行してください。',
    'Tripo 인증 정보가 올바르지 않습니다. 설정을 업데이트한 후 재시도해 주세요.',
    'Учётные данные Tripo недействительны. Обновите настройки перед повтором.',
    'Les identifiants Tripo sont invalides. Mettez à jour la configuration avant de réessayer.',
  ],
  unexpected: [
    '生成服务发生未预期异常，请查看 Aura 后端日志后重试。',
    'The generation service encountered an unexpected error. Check the Aura backend logs before retrying.',
    '生成サービスで予期しないエラーが発生しました。再試行する前に Aura のバックエンドログを確認してください。',
    '생성 서비스에서 예기치 않은 오류가 발생했습니다. 재시도하기 전에 Aura 백엔드 로그를 확인해 주세요.',
    'Неожиданная ошибка сервиса генерации. Перед повтором проверьте журналы сервера Aura.',
    'Le service de génération a rencontré une erreur inattendue. Consultez les journaux du backend Aura avant de réessayer.',
  ],
  referenceConflict: [
    '请选择一种参考图来源。',
    'Choose one reference image source.',
    '参考画像の入力元を 1 つ選択してください。',
    '참조 이미지 소스를 하나만 선택해 주세요.',
    'Выберите один источник исходного изображения.',
    'Choisissez une seule source d’image de référence.',
  ],
  referenceUnavailable: [
    '托管参考图暂不可用。',
    'Managed reference images are unavailable.',
    '管理対象の参考画像を利用できません。',
    '관리되는 참조 이미지를 사용할 수 없습니다.',
    'Управляемые исходные изображения недоступны.',
    'Les images de référence gérées sont indisponibles.',
  ],
  imageUnavailable: [
    'Tripo 图片生成尚未配置。',
    'Tripo image generation is not configured.',
    'Tripo の画像生成が設定されていません。',
    'Tripo 이미지 생성이 설정되지 않았습니다.',
    'Генерация изображений Tripo не настроена.',
    'La génération d’images Tripo n’est pas configurée.',
  ],
  resultUnknown: [
    '付费请求可能已经开始，请先核对任务和账本，不要自动重试或重复付费。',
    'A paid request may have started. Reconcile the task and ledger before continuing; do not retry automatically or pay again.',
    '有料リクエストが開始された可能性があります。先にタスクと台帳を確認してください。自動再試行や重複課金を行わないでください。',
    '유료 요청이 시작되었을 수 있습니다. 먼저 작업과 원장을 확인해 주세요. 자동으로 재시도하거나 중복 결제하지 마세요.',
    'Платный запрос мог начаться. Сверьте задачу и журнал; не повторяйте автоматически и не оплачивайте снова.',
    'Une requête payante a peut-être démarré. Vérifiez la tâche et le registre ; ne réessayez pas automatiquement et ne payez pas à nouveau.',
  ],
  costUnknown: [
    '已保留付费图片，请核对实际费用后再继续。',
    'The paid image is retained. Reconcile its actual cost before continuing.',
    '有料画像は保存されています。実際の費用を確認してから続行してください。',
    '유료 이미지가 보관되어 있습니다. 실제 비용을 확인한 후 계속해 주세요.',
    'Оплаченное изображение сохранено. Сверьте фактическую стоимость перед продолжением.',
    'L’image payante est conservée. Vérifiez son coût réel avant de continuer.',
  ],
  ledgerInvalid: [
    'Tripo 账本无效或无法读取，请修复账本后再继续。',
    'The Tripo ledger is invalid or unreadable. Repair it before continuing.',
    'Tripo の台帳が無効か読み取れません。修復してから続行してください。',
    'Tripo 원장이 올바르지 않거나 읽을 수 없습니다. 복구한 후 계속해 주세요.',
    'Журнал Tripo недействителен или недоступен для чтения. Исправьте его перед продолжением.',
    'Le registre Tripo est invalide ou illisible. Réparez-le avant de continuer.',
  ],
  ledgerLocked: [
    'Tripo 账本已锁定或需要恢复，未提交付费请求。',
    'The Tripo ledger is locked or requires recovery. No paid request was submitted.',
    'Tripo の台帳がロックされているか復元が必要です。有料リクエストは送信されていません。',
    'Tripo 원장이 잠겼거나 복구가 필요합니다. 유료 요청은 제출되지 않았습니다.',
    'Журнал Tripo заблокирован или требует восстановления. Платный запрос не отправлен.',
    'Le registre Tripo est verrouillé ou doit être restauré. Aucune requête payante n’a été envoyée.',
  ],
  budgetMissing: [
    'Tripo 预算未配置或无效，未提交付费请求。',
    'The Tripo budget is not configured or is invalid. No paid request was submitted.',
    'Tripo の予算が未設定か無効です。有料リクエストは送信されていません。',
    'Tripo 예산이 설정되지 않았거나 올바르지 않습니다. 유료 요청은 제출되지 않았습니다.',
    'Бюджет Tripo не настроен или недействителен. Платный запрос не отправлен.',
    'Le budget Tripo est absent ou invalide. Aucune requête payante n’a été envoyée.',
  ],
  identityConflict: [
    '付费请求标识冲突，输入改变后不能复用或重新支付同一任务。',
    'Paid request identity conflict. Changed input cannot reuse or repay the same task.',
    '有料リクエストの ID が競合しています。入力を変更した同じタスクの再利用や再支払いはできません。',
    '유료 요청 ID가 충돌합니다. 입력을 변경한 후 같은 작업을 재사용하거나 다시 결제할 수 없습니다.',
    'Конфликт идентификатора платного запроса. При изменении данных нельзя повторно использовать или оплатить ту же задачу.',
    'Conflit d’identifiant de requête payante. Une entrée modifiée ne peut pas réutiliser ni repayer la même tâche.',
  ],
  reconcileRequired: [
    '付费任务记录不一致，请先核对已保留的任务及结果，不要重新生成。',
    'Paid task records do not match. Reconcile retained tasks and results before continuing; do not regenerate.',
    '有料タスクの記録が一致しません。保存済みのタスクと結果を確認し、再生成しないでください。',
    '유료 작업 기록이 일치하지 않습니다. 보관된 작업과 결과를 확인하고 다시 생성하지 마세요.',
    'Записи платной задачи не совпадают. Сверьте сохранённые задачи и результаты; не генерируйте заново.',
    'Les enregistrements de la tâche payante ne correspondent pas. Vérifiez les tâches et résultats conservés ; ne relancez pas la génération.',
  ],
  paidWorkForbidden: [
    '此任务不能发起新的付费请求，请复用已保留结果。',
    'This task cannot start new paid requests. Reuse its retained results.',
    'このタスクでは新しい有料リクエストを開始できません。保存済みの結果を再利用してください。',
    '이 작업은 새 유료 요청을 시작할 수 없습니다. 보관된 결과를 재사용해 주세요.',
    'Эта задача не может отправлять новые платные запросы. Используйте сохранённые результаты.',
    'Cette tâche ne peut pas démarrer de nouvelle requête payante. Réutilisez ses résultats conservés.',
  ],
  overspent: [
    '实际费用超过阶段预算上限，请停止新的付费请求并核对预算。',
    'The actual charge exceeded the stage ceiling. Stop new paid requests and reconcile the budget.',
    '実際の費用がステージの予算上限を超えています。新しい有料リクエストを停止し、予算を確認してください。',
    '실제 비용이 단계 예산 한도를 초과했습니다. 새 유료 요청을 중지하고 예산을 확인해 주세요.',
    'Фактическая стоимость превысила лимит этапа. Остановите новые платные запросы и сверьте бюджет.',
    'Le coût réel a dépassé le plafond de l’étape. Arrêtez les nouvelles requêtes payantes et vérifiez le budget.',
  ],
  accountingUnit: [
    '云端计费单位必须明确设为 tripo_credits，未提交付费请求。',
    'The cloud accounting unit must be tripo_credits. No paid request was submitted.',
    'クラウドの課金単位は tripo_credits に設定してください。有料リクエストは送信されていません。',
    '클라우드 과금 단위를 tripo_credits로 설정해야 합니다. 유료 요청은 제출되지 않았습니다.',
    'Единица облачного учёта должна быть tripo_credits. Платный запрос не отправлен.',
    'L’unité de facturation cloud doit être tripo_credits. Aucune requête payante n’a été envoyée.',
  ],
  stageBudgetMissing: [
    '阶段预算上限未配置，未提交付费请求。',
    'The stage credit ceiling is not configured. No paid request was submitted.',
    'ステージのクレジット上限が未設定です。有料リクエストは送信されていません。',
    '단계 크레딧 한도가 설정되지 않았습니다. 유료 요청은 제출되지 않았습니다.',
    'Лимит кредитов этапа не настроен. Платный запрос не отправлен.',
    'Le plafond de crédits de l’étape n’est pas configuré. Aucune requête payante n’a été envoyée.',
  ],
  creditLimit: [
    '本次请求将超过 Tripo 总预算上限，未提交付费请求。',
    'This request would exceed the total Tripo credit limit. No paid request was submitted.',
    'このリクエストは Tripo の合計クレジット上限を超えます。有料リクエストは送信されていません。',
    '이 요청은 Tripo 총 크레딧 한도를 초과합니다. 유료 요청은 제출되지 않았습니다.',
    'Запрос превысит общий лимит кредитов Tripo. Платный запрос не отправлен.',
    'Cette requête dépasserait le plafond total de crédits Tripo. Aucune requête payante n’a été envoyée.',
  ],
  scopeBudgetMissing: [
    '单项任务预算上限未配置，未提交付费请求。',
    'The per-task credit ceiling is not configured. No paid request was submitted.',
    'タスクごとのクレジット上限が未設定です。有料リクエストは送信されていません。',
    '작업별 크레딧 한도가 설정되지 않았습니다. 유료 요청은 제출되지 않았습니다.',
    'Лимит кредитов на задачу не настроен. Платный запрос не отправлен.',
    'Le plafond de crédits par tâche n’est pas configuré. Aucune requête payante n’a été envoyée.',
  ],
  scopeCreditLimit: [
    '本次请求将超过单项任务预算上限，未提交付费请求。',
    'This request would exceed the per-task credit limit. No paid request was submitted.',
    'このリクエストはタスクごとのクレジット上限を超えます。有料リクエストは送信されていません。',
    '이 요청은 작업별 크레딧 한도를 초과합니다. 유료 요청은 제출되지 않았습니다.',
    'Запрос превысит лимит кредитов на задачу. Платный запрос не отправлен.',
    'Cette requête dépasserait le plafond de crédits par tâche. Aucune requête payante n’a été envoyée.',
  ],
  bytesLimit: [
    '付费结果超过本地保留大小上限，请核对结果，不要重新生成。',
    'The paid result exceeds the local retention size limit. Reconcile the result; do not regenerate.',
    '有料の結果がローカル保存のサイズ上限を超えています。結果を確認し、再生成しないでください。',
    '유료 결과가 로컬 보관 크기 한도를 초과했습니다. 결과를 확인하고 다시 생성하지 마세요.',
    'Платный результат превышает лимит локального хранения. Сверьте результат; не генерируйте заново.',
    'Le résultat payant dépasse la limite de stockage local. Vérifiez le résultat ; ne relancez pas la génération.',
  ],
  retainedChanged: [
    '已保留的付费结果发生变化，请检查存储，不要重新生成。',
    'The retained paid result has changed. Check storage; do not regenerate.',
    '保存済みの有料の結果が変更されています。ストレージを確認し、再生成しないでください。',
    '보관된 유료 결과가 변경되었습니다. 저장소를 확인하고 다시 생성하지 마세요.',
    'Сохранённый платный результат изменился. Проверьте хранилище; не генерируйте заново.',
    'Le résultat payant conservé a changé. Vérifiez le stockage ; ne relancez pas la génération.',
  ],
} as const satisfies Record<string, TranslationRow>;
export type TripoErrorKey = keyof typeof messages;
const errors = new WeakMap<Error, ErrorTranslations>();

export function tripoErrorMessages(key: TripoErrorKey): ErrorTranslations {
  return Object.fromEntries(
    locales.map((locale, index) => [locale, messages[key][index]]),
  ) as ErrorTranslations;
}
export function retainErrorTranslations(
  error: Error,
  translations: ErrorTranslations,
): void {
  errors.set(error, translations);
}
export function tripoErrorTranslations(
  error: Error,
): ErrorTranslations | undefined {
  return errors.get(error);
}

const stages = {
  'prepare-output': [
    '准备输出目录',
    'Prepare output folder',
    '出力フォルダーの準備',
    '출력 폴더 준비',
    'Подготовка папки вывода',
    'Préparer le dossier de sortie',
  ],
  'read-reference': [
    '读取参考图',
    'Read reference image',
    '参考画像の読み取り',
    '참조 이미지 읽기',
    'Чтение исходного изображения',
    'Lire l’image de référence',
  ],
  'upload-reference': [
    '上传参考图',
    'Upload reference image',
    '参考画像のアップロード',
    '참조 이미지 업로드',
    'Загрузка исходного изображения',
    'Envoyer l’image de référence',
  ],
  'generate-front': [
    '生成前视图',
    'Generate front view',
    '正面図の生成',
    '정면 뷰 생성',
    'Генерация вида спереди',
    'Générer la vue de face',
  ],
  'generate-left': [
    '生成左视图',
    'Generate left view',
    '左側面図の生成',
    '왼쪽 뷰 생성',
    'Генерация вида слева',
    'Générer la vue de gauche',
  ],
  'generate-back': [
    '生成后视图',
    'Generate back view',
    '背面図の生成',
    '후면 뷰 생성',
    'Генерация вида сзади',
    'Générer la vue arrière',
  ],
  'generate-right': [
    '生成右视图',
    'Generate right view',
    '右側面図の生成',
    '오른쪽 뷰 생성',
    'Генерация вида справа',
    'Générer la vue de droite',
  ],
  'download-front': [
    '下载前视图',
    'Download front view',
    '正面図のダウンロード',
    '정면 뷰 다운로드',
    'Скачивание вида спереди',
    'Télécharger la vue de face',
  ],
  'download-left': [
    '下载左视图',
    'Download left view',
    '左側面図のダウンロード',
    '왼쪽 뷰 다운로드',
    'Скачивание вида слева',
    'Télécharger la vue de gauche',
  ],
  'download-back': [
    '下载后视图',
    'Download back view',
    '背面図のダウンロード',
    '후면 뷰 다운로드',
    'Скачивание вида сзади',
    'Télécharger la vue arrière',
  ],
  'download-right': [
    '下载右视图',
    'Download right view',
    '右側面図のダウンロード',
    '오른쪽 뷰 다운로드',
    'Скачивание вида справа',
    'Télécharger la vue de droite',
  ],
  'generate-model': [
    '生成 3D 模型',
    'Generate 3D model',
    '3D モデルの生成',
    '3D 모델 생성',
    'Генерация 3D-модели',
    'Générer le modèle 3D',
  ],
  'download-model': [
    '下载 3D 模型',
    'Download 3D model',
    '3D モデルのダウンロード',
    '3D 모델 다운로드',
    'Скачивание 3D-модели',
    'Télécharger le modèle 3D',
  ],
  'download-preview': [
    '下载模型预览',
    'Download model preview',
    'モデルプレビューのダウンロード',
    '모델 미리보기 다운로드',
    'Скачивание предпросмотра модели',
    'Télécharger l’aperçu du modèle',
  ],
  'publish-output': [
    '保存生成结果',
    'Save generated results',
    '生成結果の保存',
    '생성 결과 저장',
    'Сохранение результатов',
    'Enregistrer les résultats générés',
  ],
} as const satisfies Record<string, TranslationRow>;
const reasons = {
  timeout: [
    '等待超时，任务可能仍在后台处理。请先核对任务状态，避免重复提交和计费。',
    'The wait timed out; the task may still be processing. Reconcile its status before resubmitting to avoid duplicate charges.',
    '待機がタイムアウトしました。タスクは処理中の可能性があります。重複送信や課金を避けるため、先に状態を確認してください。',
    '대기 시간이 초과되었습니다. 작업이 계속 처리 중일 수 있습니다. 중복 제출과 결제를 피하려면 먼저 상태를 확인해 주세요.',
    'Время ожидания истекло; задача может ещё выполняться. Проверьте её статус перед повтором, чтобы избежать двойной оплаты.',
    'Le délai d’attente a expiré ; la tâche est peut-être encore en cours. Vérifiez son état avant tout nouvel envoi pour éviter une double facturation.',
  ],
  network: [
    '无法连接 Tripo，请检查网络或代理后重试。',
    'Could not connect to Tripo. Check the network or proxy before retrying.',
    'Tripo に接続できません。再試行する前にネットワークやプロキシを確認してください。',
    'Tripo에 연결할 수 없습니다. 재시도하기 전에 네트워크나 프록시를 확인해 주세요.',
    'Не удалось подключиться к Tripo. Проверьте сеть или прокси перед повтором.',
    'Impossible de se connecter à Tripo. Vérifiez le réseau ou le proxy avant de réessayer.',
  ],
  'provider-rejected': [
    'Tripo 拒绝了请求，请检查输入和服务配置。',
    'Tripo rejected the request. Check the input and service configuration.',
    'Tripo がリクエストを拒否しました。入力とサービス設定を確認してください。',
    'Tripo가 요청을 거부했습니다. 입력과 서비스 설정을 확인해 주세요.',
    'Tripo отклонил запрос. Проверьте входные данные и настройки сервиса.',
    'Tripo a refusé la requête. Vérifiez les données et la configuration du service.',
  ],
  'task-failed': [
    '上游任务执行失败，请稍后重试；若持续发生，请查看 Aura 后端日志。',
    'The upstream task failed. Try later; if it persists, check the Aura backend logs.',
    '上流のタスクが失敗しました。後で再試行し、問題が続く場合は Aura のバックエンドログを確認してください。',
    '상위 서비스 작업에 실패했습니다. 나중에 재시도하고 문제가 계속되면 Aura 백엔드 로그를 확인해 주세요.',
    'Задача внешнего сервиса завершилась с ошибкой. Повторите позже; при повторении проверьте журналы сервера Aura.',
    'La tâche du service externe a échoué. Réessayez plus tard ; si le problème persiste, consultez les journaux du backend Aura.',
  ],
  'task-cancelled': [
    '上游任务已取消，请确认服务状态后重试。',
    'The upstream task was cancelled. Check the service status before retrying.',
    '上流のタスクがキャンセルされました。サービスの状態を確認してから再試行してください。',
    '상위 서비스 작업이 취소되었습니다. 서비스 상태를 확인한 후 재시도해 주세요.',
    'Задача внешнего сервиса отменена. Проверьте статус сервиса перед повтором.',
    'La tâche du service externe a été annulée. Vérifiez l’état du service avant de réessayer.',
  ],
  'content-policy': [
    '内容未通过生成服务检查，请调整描述或参考图后重试。',
    'The content did not pass the generation service checks. Adjust the prompt or reference image before retrying.',
    'コンテンツが生成サービスのチェックを通過しませんでした。説明や参考画像を調整してから再試行してください。',
    '콘텐츠가 생성 서비스 검사를 통과하지 못했습니다. 설명이나 참조 이미지를 수정한 후 재시도해 주세요.',
    'Контент не прошёл проверку сервиса генерации. Измените описание или исходное изображение перед повтором.',
    'Le contenu n’a pas passé les vérifications du service. Modifiez la description ou l’image de référence avant de réessayer.',
  ],
  'local-io': [
    '本地文件处理失败，请检查文件格式、网络、目录权限和剩余空间。',
    'Local file processing failed. Check file formats, network access, folder permissions and free space.',
    'ローカルファイルの処理に失敗しました。ファイル形式、ネットワーク、フォルダーの権限、空き容量を確認してください。',
    '로컬 파일 처리에 실패했습니다. 파일 형식, 네트워크, 폴더 권한과 여유 공간을 확인해 주세요.',
    'Ошибка обработки локальных файлов. Проверьте форматы, сеть, права на папки и свободное место.',
    'Le traitement des fichiers locaux a échoué. Vérifiez les formats, le réseau, les droits du dossier et l’espace libre.',
  ],
} as const satisfies Record<string, TranslationRow>;
export function tripoStageMessages(
  stage: keyof typeof stages,
  reason: keyof typeof reasons | 'unexpected',
  options?: {
    indeterminate?: boolean;
    credentialInvalid?: boolean;
    seconds?: number;
    providerCode?: number;
    retainedMissing?: boolean;
    referenceInvalid?: boolean;
  },
): ErrorTranslations {
  let details: ErrorTranslations;
  if (options?.indeterminate) details = tripoErrorMessages('resultUnknown');
  else if (options?.credentialInvalid)
    details = tripoErrorMessages('keyInvalid');
  else if (options?.retainedMissing)
    details = tripoErrorMessages('reconcileRequired');
  else if (options?.referenceInvalid)
    details = {
      en: 'The reference image must be PNG, JPEG or WebP and no larger than 20 MiB.',
      'zh-CN': '参考图必须为 PNG、JPEG 或 WebP，且不超过 20 MiB。',
      ja: '参考画像は 20 MiB 以下の PNG、JPEG、WebP を使用してください。',
      ko: '참조 이미지는 20 MiB 이하의 PNG, JPEG 또는 WebP여야 합니다.',
      ru: 'Исходное изображение должно быть PNG, JPEG или WebP размером не более 20 МиБ.',
      fr: 'L’image de référence doit être au format PNG, JPEG ou WebP et ne pas dépasser 20 Mio.',
    };
  else if (reason === 'unexpected') details = tripoErrorMessages('unexpected');
  else
    details = Object.fromEntries(
      locales.map((locale, index) => [locale, reasons[reason][index]]),
    ) as ErrorTranslations;
  const result = { en: '' } as ErrorTranslations;
  for (const [index, locale] of locales.entries()) {
    const seconds = options?.seconds;
    const code = options?.providerCode;
    let suffix = '';
    if (
      reason === 'timeout' &&
      typeof seconds === 'number' &&
      Number.isSafeInteger(seconds) &&
      seconds > 0 &&
      seconds <= 86400
    )
      suffix = ` (${new Intl.NumberFormat(locale).format(seconds)} s)`;
    else if (
      reason === 'provider-rejected' &&
      typeof code === 'number' &&
      Number.isSafeInteger(code) &&
      Math.abs(code) <= 1e9
    )
      suffix = ` (${code})`;
    result[locale] =
      `${stages[stage][index]}${suffix}: ${details[locale] ?? details.en}`;
  }
  return result;
}
