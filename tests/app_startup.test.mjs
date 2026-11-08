import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';

test('actual App renders the empty workspace before any page or decoded frame exists', async () => {
  const source=await readFile(new URL('../src/App.tsx',import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const context=vm.createContext({window:{innerWidth:1536},localStorage:{getItem:()=>null}});
  const ast=ts.createSourceFile('App.js',code,ts.ScriptTarget.ES2022,true,ts.ScriptKind.JS);
  const imports=new Map();
  for(const node of ast.statements)if(ts.isImportDeclaration(node)){
    const names=node.importClause?.namedBindings?.elements?.map(item=>item.propertyName?.text??item.name.text)??[];
    imports.set(node.moduleSpecifier.text,names);
  }
  const app=new vm.SourceTextModule(code,{context});
  await app.link(async name=>{
    let values;
    if(name==='react'||name==='react/jsx-runtime')values=await import(name);
    else {
      values=Object.fromEntries((imports.get(name)??[]).map(key=>[key,key==='sourceValue'?()=>'' : /^[A-Z]/.test(key)?props=>props?.children??null:()=>{}]));
      for(const key of ['PageFrames','PageNavigation','TypographySession','ViewportController','RegionInteraction'])if(key in values)values[key]=class{getSnapshot(){return {mode:'dual'};}};
      if('ApiError' in values)values.ApiError=class extends Error{};
    }
    return new vm.SyntheticModule(Object.keys(values),function(){for(const key of Object.keys(values))this.setExport(key,values[key]);},{context});
  });
  await app.evaluate();
  const html=renderToStaticMarkup(React.createElement(app.namespace.default));
  assert.match(html,/Open Image or Project/);
  assert.match(html,/Open Chapter Folder/);
  assert.match(html,/empty-workspace/);
});
