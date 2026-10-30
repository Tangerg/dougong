// Discovery and execution share identity data without importing an executable handler for discovery.
export interface ActionDeclaration {
  readonly id: string;
  readonly title: string;
}

export function actionActivation(action: ActionDeclaration): string {
  return `command:${action.id}`;
}
