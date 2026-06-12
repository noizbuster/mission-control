use crate::session_datetime::is_rfc3339_utc_millis;
use serde_json::{Map, Value};

pub(crate) fn require_shape(
    object: &Map<String, Value>,
    required: &[&str],
    optional: &[&str],
) -> Result<(), ()> {
    if !required.iter().all(|key| object.contains_key(*key)) {
        return Err(());
    }
    if object
        .keys()
        .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return Err(());
    }
    Ok(())
}

pub(crate) fn object(value: &Value) -> Result<&Map<String, Value>, ()> {
    value.as_object().ok_or(())
}

pub(crate) fn object_field<'a>(
    object: &'a Map<String, Value>,
    key: &str,
) -> Result<&'a Map<String, Value>, ()> {
    object.get(key).and_then(Value::as_object).ok_or(())
}

pub(crate) fn optional_object_field(object: &Map<String, Value>, key: &str) -> Result<(), ()> {
    match object.get(key) {
        Some(value) if value.is_object() => Ok(()),
        Some(_) => Err(()),
        None => Ok(()),
    }
}

pub(crate) fn array_field<'a>(
    object: &'a Map<String, Value>,
    key: &str,
) -> Result<&'a Vec<Value>, ()> {
    object.get(key).and_then(Value::as_array).ok_or(())
}

pub(crate) fn optional_array_field(object: &Map<String, Value>, key: &str) -> Result<(), ()> {
    match object.get(key) {
        Some(value) if value.is_array() => Ok(()),
        Some(_) => Err(()),
        None => Ok(()),
    }
}

pub(crate) fn string_field<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str, ()> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(())
}

pub(crate) fn optional_non_empty_string_field(
    object: &Map<String, Value>,
    key: &str,
) -> Result<(), ()> {
    match object.get(key) {
        Some(value) if value.as_str().is_some_and(|item| !item.is_empty()) => Ok(()),
        Some(_) => Err(()),
        None => Ok(()),
    }
}

pub(crate) fn timestamp_field<'a>(
    object: &'a Map<String, Value>,
    key: &str,
) -> Result<&'a str, ()> {
    let value = string_field(object, key)?;
    if is_rfc3339_utc_millis(value) {
        Ok(value)
    } else {
        Err(())
    }
}

pub(crate) fn optional_timestamp_field(object: &Map<String, Value>, key: &str) -> Result<(), ()> {
    match object.get(key) {
        Some(value) if value.as_str().is_some_and(is_rfc3339_utc_millis) => Ok(()),
        Some(_) => Err(()),
        None => Ok(()),
    }
}

pub(crate) fn string_enum_field<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    allowed: &[&str],
) -> Result<&'a str, ()> {
    let value = string_field(object, key)?;
    if allowed.contains(&value) {
        Ok(value)
    } else {
        Err(())
    }
}

pub(crate) fn optional_string_enum_field(
    object: &Map<String, Value>,
    key: &str,
    allowed: &[&str],
) -> Result<(), ()> {
    match object.get(key) {
        Some(value) if value.as_str().is_some_and(|item| allowed.contains(&item)) => Ok(()),
        Some(_) => Err(()),
        None => Ok(()),
    }
}

pub(crate) fn usize_field(object: &Map<String, Value>, key: &str) -> Result<usize, ()> {
    let value = object.get(key).and_then(Value::as_u64).ok_or(())?;
    usize::try_from(value).map_err(|_| ())
}

pub(crate) fn u64_field(object: &Map<String, Value>, key: &str) -> Result<u64, ()> {
    object.get(key).and_then(Value::as_u64).ok_or(())
}

pub(crate) fn optional_usize_field(object: &Map<String, Value>, key: &str) -> Result<(), ()> {
    match object.get(key) {
        Some(value)
            if value
                .as_u64()
                .and_then(|item| usize::try_from(item).ok())
                .is_some() =>
        {
            Ok(())
        }
        Some(_) => Err(()),
        None => Ok(()),
    }
}

pub(crate) fn optional_positive_usize_field(
    object: &Map<String, Value>,
    key: &str,
) -> Result<Option<usize>, ()> {
    match object.get(key) {
        Some(value) => {
            let value = value
                .as_u64()
                .and_then(|item| usize::try_from(item).ok())
                .ok_or(())?;
            if value == 0 {
                return Err(());
            }
            Ok(Some(value))
        }
        None => Ok(None),
    }
}

pub(crate) fn boolean_field(object: &Map<String, Value>, key: &str) -> Result<bool, ()> {
    object.get(key).and_then(Value::as_bool).ok_or(())
}

pub(crate) fn optional_string_array_field(
    object: &Map<String, Value>,
    key: &str,
) -> Result<(), ()> {
    match object.get(key) {
        Some(Value::Array(values))
            if values
                .iter()
                .all(|value| value.as_str().is_some_and(|item| !item.is_empty())) =>
        {
            Ok(())
        }
        Some(_) => Err(()),
        None => Ok(()),
    }
}
