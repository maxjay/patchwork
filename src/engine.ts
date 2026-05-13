export class Engine<T = any> {
  base: T;

  constructor(base: T) {
    this.base = base;
  }

  add(path: string, value: any): void {
  }

  replace(path: string, value: any): void {
  }

  delete(path: string): void {
  }

  move(from: string, to: string): void {
  }

  copy(from: string, to: string): void {
  }
}