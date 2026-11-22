declare module 'chart.js' {
  export interface ChartConfiguration {
    type?: string;
    data?: unknown;
    options?: Record<string, any>;
  }
  export class Chart {
    constructor(el: HTMLCanvasElement, config: ChartConfiguration);
    destroy(): void;
    static register(...items: unknown[]): void;
  }
  export const registerables: unknown[];
}
