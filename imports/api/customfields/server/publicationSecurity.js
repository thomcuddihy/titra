const CUSTOM_FIELD_CLIENT_FIELDS = Object.freeze({
  classname: 1,
  name: 1,
  desc: 1,
  type: 1,
  possibleValues: 1,
  category: 1,
})

const USER_CUSTOM_FIELD_CLASSES = new Set(['project', 'task', 'time_entry'])

function userCustomFieldClass(classname) {
  return typeof classname === 'string' && USER_CUSTOM_FIELD_CLASSES.has(classname)
}

export {
  CUSTOM_FIELD_CLIENT_FIELDS,
  USER_CUSTOM_FIELD_CLASSES,
  userCustomFieldClass,
}
