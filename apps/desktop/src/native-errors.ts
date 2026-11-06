import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type {
  NativeFailure,
  NativeFailureCode,
} from "@aura/protocol/native-ui";

export class NativeOperationError extends Error {
  readonly code: NativeFailureCode;
  constructor(code: NativeFailureCode) {
    super(code);
    this.code = code;
  }
}

/** Return safe structured values: Electron does not preserve custom Error fields. */
export function handleNative<Args extends unknown[], Value>(
  channel: string,
  fallback: NativeFailureCode,
  handler: (event: IpcMainInvokeEvent, ...args: Args) => Value | Promise<Value>,
): void {
  ipcMain.handle(
    channel,
    async (event, ...args): Promise<Value | NativeFailure> => {
      try {
        return await handler(event, ...(args as Args));
      } catch (error) {
        return {
          type: "aura.native.failure",
          code: error instanceof NativeOperationError ? error.code : fallback,
        };
      }
    },
  );
}
