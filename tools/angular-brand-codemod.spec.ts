import { describe, expect, it } from 'vitest';
import { Project, QuoteKind, ts } from 'ts-morph';
import {
  AngularBrandCodemodOptions,
  extractConstructorDeps,
  extractDecoratorMetadataDeps,
  extractInjectCallDeps,
  findAngularDecoratedClass,
  getAngularKind,
  isStandaloneDeclarable,
  transformSourceFile,
  TransformResult,
} from './angular-brand-codemod';

type ApplyTransformOptions = AngularBrandCodemodOptions & {
  extraFiles?: Record<string, string>;
};

export function applyTransform(input: string, options: ApplyTransformOptions = {}): string {
  return applyTransformWithResult(input, options).output;
}

export function applyTransformWithResult(
  input: string,
  options: ApplyTransformOptions = {},
): { output: string; result: TransformResult } {
  const project = createInMemoryProject();
  for (const [filePath, source] of Object.entries(options.extraFiles ?? {})) {
    project.createSourceFile(filePath, source);
  }

  const sourceFile = project.createSourceFile('/project/source.ts', input);
  const result = transformSourceFile(sourceFile, options);

  return {
    output: sourceFile.getFullText(),
    result,
  };
}

export function normalizeCode(code: string): string {
  const project = createInMemoryProject();
  const sourceFile = project.createSourceFile('/project/normalize.ts', code.trim());
  sourceFile.formatText({ convertTabsToSpaces: true, indentSize: 2 });
  return sourceFile.getFullText().trim();
}

describe('Angular brand codemod helpers', () => {
  it('detects supported Angular decorator kinds', () => {
    const sourceFile = createSourceFile(`
      @Component({})
      class AppComponent {}

      @Directive({})
      class AppDirective {}

      @Pipe({ name: 'x' })
      class AppPipe {}

      @Injectable()
      class AppService {}
    `);

    const [component, directive, pipe, injectable] = sourceFile.getClasses();

    expect(getAngularKind(component)).toBe('component');
    expect(getAngularKind(directive)).toBe('directive');
    expect(getAngularKind(pipe)).toBe('pipe');
    expect(getAngularKind(injectable)).toBe('injectable');
  });

  it('detects standalone components and directives only when standalone is true', () => {
    const sourceFile = createSourceFile(`
      @Component({ standalone: true })
      class StandaloneComponent {}

      @Directive({ standalone: false })
      class NonStandaloneDirective {}

      @Pipe({ standalone: true, name: 'x' })
      class AppPipe {}
    `);

    const [standaloneComponent, nonStandaloneDirective, pipe] = sourceFile.getClasses();

    expect(isStandaloneDeclarable(standaloneComponent)).toBe(true);
    expect(isStandaloneDeclarable(nonStandaloneDirective)).toBe(false);
    expect(isStandaloneDeclarable(pipe)).toBe(false);
  });

  it('extracts static metadata dependencies in the required metadata order', () => {
    const sourceFile = createSourceFile(`
      @Component({
        standalone: true,
        imports: [CommonModule, [RouterLink], ...sharedImports],
        hostDirectives: [TooltipDirective, { directive: FocusDirective }],
        providers: [MyService, { provide: TOKEN, useClass: TokenService }, makeProvider()],
        viewProviders: [ViewService],
      })
      class DemoComponent {}
    `);

    const extraction = extractDecoratorMetadataDeps(sourceFile.getClassOrThrow('DemoComponent'));

    expect(extraction.dependencies).toEqual([
      'CommonModule',
      'RouterLink',
      'TooltipDirective',
      'FocusDirective',
      'MyService',
      'TOKEN',
      'TokenService',
      'makeProvider',
      'ViewService',
    ]);
    expect(extraction.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('spread element')]),
    );
  });

  it('extracts constructor dependencies from @Inject tokens and runtime value types', () => {
    const sourceFile = createSourceFile(`
      class ApiService {}
      const TOKEN = {};
      interface InterfaceOnly {}

      class DemoComponent {
        constructor(
          private api: ApiService,
          @Inject(TOKEN) token: string,
          primitive: string,
          unresolved: MissingService,
          interfaceOnly: InterfaceOnly,
        ) {}
      }
    `);

    const extraction = extractConstructorDeps(sourceFile.getClassOrThrow('DemoComponent'));

    expect(extraction.dependencies).toEqual(['ApiService', 'TOKEN']);
    expect(extraction.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('primitive'),
        expect.stringContaining('MissingService'),
        expect.stringContaining('InterfaceOnly'),
      ]),
    );
  });

  it('skips imported interfaces and type-only imports when extracting constructor types', () => {
    const project = createInMemoryProject();
    project.createSourceFile(
      '/project/deps.ts',
      `
        export interface ApiContract {}
        export class ApiService {}
        export class TypeOnlyService {}
      `,
    );
    const sourceFile = project.createSourceFile(
      '/project/source.ts',
      `
        import { ApiContract, ApiService } from './deps';
        import type { TypeOnlyService } from './deps';
        import * as deps from './deps';

        class DemoComponent {
          constructor(
            apiContract: ApiContract,
            api: ApiService,
            typeOnly: TypeOnlyService,
            namespaceApi: deps.ApiService,
            namespaceContract: deps.ApiContract,
          ) {}
        }
      `,
    );

    const extraction = extractConstructorDeps(sourceFile.getClassOrThrow('DemoComponent'));

    expect(extraction.dependencies).toEqual(['ApiService', 'deps.ApiService']);
    expect(extraction.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('ApiContract'),
        expect.stringContaining('TypeOnlyService'),
        expect.stringContaining('deps.ApiContract'),
      ]),
    );
  });

  it('does not fall back to the parameter type when @Inject has a complex token', () => {
    const sourceFile = createSourceFile(`
      class ApiService {}

      class DemoComponent {
        constructor(@Inject(getToken()) api: ApiService) {}
      }
    `);

    const extraction = extractConstructorDeps(sourceFile.getClassOrThrow('DemoComponent'));

    expect(extraction.dependencies).toEqual([]);
    expect(extraction.warnings).toEqual([expect.stringContaining('@Inject() dependency')]);
  });

  it('extracts inject() call dependencies and skips complex tokens', () => {
    const sourceFile = createSourceFile(`
      class Router {}
      namespace tokens {
        export const AUTH = {};
      }

      class DemoComponent {
        private router = inject(Router);
        private auth = inject(tokens.AUTH);
        private dynamic = inject(getToken());
      }
    `);

    const extraction = extractInjectCallDeps(sourceFile.getClassOrThrow('DemoComponent'));

    expect(extraction.dependencies).toEqual(['Router', 'tokens.AUTH']);
    expect(extraction.warnings).toEqual([expect.stringContaining('inject() call')]);
  });

  it('extracts inject-prefixed helper calls as injected dependencies', () => {
    const sourceFile = createSourceFile(`
      class DemoComponent {
        private api = injectApiService();
        private store = injectFullDemo({ id: '1' });
        private namespaced = services.injectRouter();
        private dynamic = this.injectLocal();
      }
    `);

    const extraction = extractInjectCallDeps(sourceFile.getClassOrThrow('DemoComponent'));

    expect(extraction.dependencies).toEqual([
      'injectApiService',
      'injectFullDemo',
      'services.injectRouter',
    ]);
    expect(extraction.warnings).toEqual([expect.stringContaining('injectLocal() call')]);
  });
});

describe('Angular brand codemod transformations', () => {
  it('rewrites a component fixture with metadata, constructor, and inject() dependencies', () => {
    const { output, result } = applyTransformWithResult(`
      import { Component, Inject, inject } from '@angular/core';

      class CommonModule {}
      class RouterLink {}
      class TooltipDirective {}
      class MyService {}
      class ViewService {}
      class ApiService {}
      class Router {}
      function provideDemo() {
        return [];
      }
      function injectFullDemo() {
        return {};
      }
      const TOKEN = {};

      export const untouched = 1;

      @Component({
        standalone: true,
        imports: [CommonModule, RouterLink],
        hostDirectives: [TooltipDirective],
        providers: [MyService, provideDemo()],
        viewProviders: [ViewService],
      })
      export class DemoComponent {
        private router = inject(Router);
        private store = injectFullDemo();

        constructor(private api: ApiService, @Inject(TOKEN) token: unknown) {}
      }
    `);

    expect(result).toMatchObject({
      changed: true,
      skipped: false,
      angularKind: 'component',
      className: 'DemoComponent',
      dependencies: [
        'ApiService',
        'TOKEN',
        'Router',
        'injectFullDemo',
        'CommonModule',
        'RouterLink',
        'TooltipDirective',
        'MyService',
        'provideDemo',
        'ViewService',
      ],
      dependencyGroups: {
        injected: ['ApiService', 'TOKEN', 'Router', 'injectFullDemo'],
        importDeps: ['CommonModule', 'RouterLink', 'TooltipDirective'],
        providers: ['MyService', 'provideDemo', 'ViewService'],
      },
    });
    expect(output).toContain("import { brandAngularSymbol, deps } from '@craft-ng/core';");
    expect(output).toContain('export const untouched = 1;');
    expect(output).not.toContain('export class DemoComponent');
    expect(output).toContain('class DemoComponent');
    expect(countDefaultExports(output)).toBe(1);
    expect(output).toContain(
      'export default brandAngularSymbol(DemoComponent, deps({ injected: [ApiService, TOKEN, Router, injectFullDemo], importDeps: [CommonModule, RouterLink, TooltipDirective], providers: [MyService, provideDemo, ViewService] }));',
    );
  });

  it('rewrites a directive fixture and replaces an export default identifier', () => {
    const output = applyTransform(`
      import { Directive } from '@angular/core';

      class InputService {}

      @Directive({
        standalone: true,
        hostDirectives: [FocusableDirective],
      })
      class DemoDirective {
        constructor(input: InputService) {}
      }

      class FocusableDirective {}

      export default DemoDirective;
    `);

    expect(output).not.toContain('export default DemoDirective;');
    expect(output).toContain(
      'export default brandAngularSymbol(DemoDirective, deps({ injected: [InputService], importDeps: [FocusableDirective], providers: [] }));',
    );
    expect(countDefaultExports(output)).toBe(1);
  });

  it('rewrites a pipe fixture using only injection dependencies', () => {
    const output = applyTransform(`
      import { Pipe, inject } from '@angular/core';

      class DateAdapter {}
      class LocaleService {}

      @Pipe({ name: 'demo', standalone: true })
      export default class DemoPipe {
        private locale = inject(LocaleService);

        constructor(adapter: DateAdapter) {}
      }
    `);

    expect(output).toContain('class DemoPipe');
    expect(output).not.toContain('export default class DemoPipe');
    expect(output).toContain(
      'export default brandAngularSymbol(DemoPipe, deps({ injected: [DateAdapter, LocaleService], importDeps: [], providers: [] }));',
    );
  });

  it('rewrites an injectable fixture and removes named class exports', () => {
    const output = applyTransform(`
      import { Injectable } from '@angular/core';

      class HttpClient {}

      @Injectable()
      class DemoService {
        constructor(http: HttpClient) {}
      }

      export { DemoService };
      export const kept = true;
    `);

    expect(output).not.toContain('export { DemoService };');
    expect(output).toContain('export const kept = true;');
    expect(output).toContain(
      'export default brandAngularSymbol(DemoService, deps({ injected: [HttpClient], importDeps: [], providers: [] }));',
    );
  });

  it('preserves unrelated named exports while removing the transformed class export', () => {
    const output = applyTransform(`
      import { Injectable } from '@angular/core';

      class Dep {}

      @Injectable()
      class DemoService {
        constructor(dep: Dep) {}
      }

      class Other {}
      export { DemoService, Other };
    `);

    expect(output).toContain('export { Other };');
    expect(output).not.toContain('DemoService, Other');
    expect(output).toContain(
      'export default brandAngularSymbol(DemoService, deps({ injected: [Dep], importDeps: [], providers: [] }));',
    );
  });

  it('skips files with multiple supported Angular classes', () => {
    const input = `
      @Component({})
      class One {}

      @Directive({})
      class Two {}
    `;

    const { output, result } = applyTransformWithResult(input);

    expect(result.changed).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.warnings).toEqual([expect.stringContaining('2 supported Angular classes')]);
    expect(normalizeCode(output)).toBe(normalizeCode(input));
  });

  it('skips non-standalone components when standalone-only mode is enabled', () => {
    const input = `
      @Component({ standalone: false })
      export class DemoComponent {}
    `;

    const { output, result } = applyTransformWithResult(input, {
      transformOnlyStandaloneDeclarables: true,
    });

    expect(result.changed).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.warnings).toEqual([expect.stringContaining('not standalone')]);
    expect(normalizeCode(output)).toBe(normalizeCode(input));
  });

  it('allows pipes when standalone-only mode is enabled', () => {
    const { result } = applyTransformWithResult(`
      @Pipe({ name: 'demo' })
      export class DemoPipe {}
    `, {
      transformOnlyStandaloneDeclarables: true,
    });

    expect(result.changed).toBe(true);
    expect(result.angularKind).toBe('pipe');
  });

  it('skips files with complex default exports', () => {
    const input = `
      @Injectable()
      export class DemoService {}

      export default makeService(DemoService);
    `;

    const { output, result } = applyTransformWithResult(input);

    expect(result.changed).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.warnings).toEqual([expect.stringContaining('complex default export')]);
    expect(normalizeCode(output)).toBe(normalizeCode(input));
  });

  it('rewrites already branded files to the structured deps shape', () => {
    const input = `
      @Injectable()
      class DemoService {
        private api = injectApiService();
      }

      export default brandAngularSymbol(DemoService, deps());
    `;

    const { output, result } = applyTransformWithResult(input);

    expect(result.changed).toBe(true);
    expect(result.skipped).toBe(false);
    expect(output).toContain(
      'export default brandAngularSymbol(DemoService, deps({ injected: [injectApiService], importDeps: [], providers: [] }));',
    );
  });

  it('does not emit unresolved constructor type dependencies', () => {
    const { output, result } = applyTransformWithResult(`
      @Injectable()
      export class DemoService {
        constructor(unresolved: MissingService) {}
      }
    `);

    expect(result.changed).toBe(true);
    expect(result.dependencies).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining('MissingService')]);
    expect(output).toContain(
      'export default brandAngularSymbol(DemoService, deps({ injected: [], importDeps: [], providers: [] }));',
    );
  });

  it('skips anonymous default-exported Angular classes', () => {
    const input = `
      @Component({})
      export default class {}
    `;

    const { output, result } = applyTransformWithResult(input);

    expect(result.changed).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.warnings).toEqual([expect.stringContaining('anonymous')]);
    expect(normalizeCode(output)).toBe(normalizeCode(input));
  });
});

describe('findAngularDecoratedClass', () => {
  it('returns the single supported Angular class with kind and name', () => {
    const sourceFile = createSourceFile(`
      class Plain {}

      @Injectable()
      export class DemoService {}
    `);

    expect(findAngularDecoratedClass(sourceFile)).toMatchObject({
      skipped: false,
      angularKind: 'injectable',
      className: 'DemoService',
    });
  });
});

function createSourceFile(source: string) {
  return createInMemoryProject().createSourceFile('/project/source.ts', source);
}

function createInMemoryProject(): Project {
  return new Project({
    compilerOptions: {
      experimentalDecorators: true,
      module: ts.ModuleKind.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2022,
    },
    manipulationSettings: {
      quoteKind: QuoteKind.Single,
    },
    useInMemoryFileSystem: true,
  });
}

function countDefaultExports(output: string): number {
  const sourceFile = createSourceFile(output);
  return (
    sourceFile.getExportAssignments().filter((exportAssignment) => !exportAssignment.isExportEquals())
      .length +
    sourceFile
      .getClasses()
      .filter((classDeclaration) => classDeclaration.isDefaultExport()).length
  );
}
