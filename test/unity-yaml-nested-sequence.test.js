// § Canonical parser: sequence-item key → nested sequence + same-item map siblings.
import { test, expect } from 'bun:test';
import { parseUnityYamlBody } from '../tools/unity/unity-yaml.mjs';
const parse = text => parseUnityYamlBody(text.split('\n'));
test('nested prefab sequences retain dense exact int64 refs and sibling fields', () => {
  const value = parse(`MonoBehaviour:
  dictionary:
    values:
    - Prefabs:
      - {fileID: 1605591932368150452, guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: 3}
      - {fileID: -9223372036854775808, guid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, type: 3}
      Weight: 0
    - Prefabs: []
      Weight: 2
  After: 7`).MonoBehaviour;
  expect(value).toEqual({dictionary:{values:[{Prefabs:[{fileID:'1605591932368150452',guid:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',type:3},{fileID:'-9223372036854775808',guid:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',type:3}],Weight:0},{Prefabs:[],Weight:2}]},After:7});
});
test('absent, null, zero and empty sequence stay distinct across nested entries', () => {
  const value=parse(`Root:
  entries:
  - Values:
    - {value: 0}
    - {value: null}
    - {}
    After: []
  - Values: null
  - Values: []
  - After: 0`).Root.entries;
  expect(value).toEqual([{Values:[{value:0},{value:null},{}],After:[]},{Values:null},{Values:[]},{After:0}]);
});
test('recursive nested sequences retain outer siblings without consuming following entries', () => {
  expect(parse(`Root:
  - Children:
    - Members:
      - 0
      - 1
      Id: first
    Tag: outer
  - Id: next`)).toEqual({Root:[{Children:[{Members:[0,1],Id:'first'}],Tag:'outer'},{Id:'next'}]});
});
