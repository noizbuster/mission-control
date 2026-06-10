const RFC3339_UTC_MILLIS_LEN: usize = 24;

pub(crate) fn is_rfc3339_utc_millis(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != RFC3339_UTC_MILLIS_LEN || !has_expected_separators(bytes) {
        return false;
    }
    let Some(parts) = DateTimeParts::parse(bytes) else {
        return false;
    };
    parts.is_valid()
}

struct DateTimeParts {
    year: u32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
}

impl DateTimeParts {
    fn parse(bytes: &[u8]) -> Option<Self> {
        Some(Self {
            year: four_digits(bytes, 0)?,
            month: two_digits(bytes, 5)?,
            day: two_digits(bytes, 8)?,
            hour: two_digits(bytes, 11)?,
            minute: two_digits(bytes, 14)?,
            second: two_digits(bytes, 17)?,
        })
    }

    fn is_valid(&self) -> bool {
        self.month >= 1
            && self.month <= 12
            && self.day >= 1
            && self.day <= days_in_month(self.year, self.month)
            && self.hour <= 23
            && self.minute <= 59
            && self.second <= 59
    }
}

fn has_expected_separators(bytes: &[u8]) -> bool {
    bytes.get(4).copied() == Some(b'-')
        && bytes.get(7).copied() == Some(b'-')
        && bytes.get(10).copied() == Some(b'T')
        && bytes.get(13).copied() == Some(b':')
        && bytes.get(16).copied() == Some(b':')
        && bytes.get(19).copied() == Some(b'.')
        && bytes.get(23).copied() == Some(b'Z')
        && three_digits(bytes, 20).is_some()
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap_year(year: u32) -> bool {
    year.is_multiple_of(400) || (year.is_multiple_of(4) && !year.is_multiple_of(100))
}

fn four_digits(bytes: &[u8], start: usize) -> Option<u32> {
    Some(
        digit(*bytes.get(start)?)? * 1000
            + digit(*bytes.get(start + 1)?)? * 100
            + digit(*bytes.get(start + 2)?)? * 10
            + digit(*bytes.get(start + 3)?)?,
    )
}

fn three_digits(bytes: &[u8], start: usize) -> Option<u32> {
    Some(
        digit(*bytes.get(start)?)? * 100
            + digit(*bytes.get(start + 1)?)? * 10
            + digit(*bytes.get(start + 2)?)?,
    )
}

fn two_digits(bytes: &[u8], start: usize) -> Option<u32> {
    Some(digit(*bytes.get(start)?)? * 10 + digit(*bytes.get(start + 1)?)?)
}

fn digit(byte: u8) -> Option<u32> {
    byte.is_ascii_digit().then_some(u32::from(byte - b'0'))
}
