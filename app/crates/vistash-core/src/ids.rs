//! 库内稳定标识的字面值规则。
//!
//! 库 ID 与提示词 ID 都是 UUID，且两者的字面值都会成为文件名或偏好键，因此"什么算
//! 合法字面值"必须只有一个实现：两处各写一遍，迟早出现一处接受大写、另一处拒绝的
//! 组合，而那种不一致只会在使用者的库里暴露。

use crate::error::{AppError, Code, Result};
use uuid::Uuid;

/// 解析规范形式的 UUID 字面值：36 字符、小写、带连字符。
///
/// 刻意不接受 `uuid` crate 同样能解析的紧凑形式、花括号形式与大写形式。提示词 ID 直接
/// 就是它的权威文件名，多一种拼法等于同一条素材可以有两个文件名，而去重、关联与回收站
/// 都以文件名定位素材。
pub(crate) fn parse_canonical_uuid(s: &str, code: Code) -> Result<Uuid> {
    let parsed = Uuid::parse_str(s)
        .map_err(|e| AppError::detailed(code, format!("不是合法 UUID：{s:?}（{e}）")))?;
    if parsed.hyphenated().to_string() != s {
        return Err(AppError::detailed(
            code,
            format!("UUID 必须是小写带连字符的规范形式：{s:?}"),
        ));
    }
    Ok(parsed)
}

/// 生成时间可排序的 UUIDv7 规范字面值。
///
/// 用 v7 而不是 v4：提示词列表默认按创建时间排序，v7 让"按 ID 排序"与"按创建时间排序"
/// 是同一个顺序，索引因此不需要为一个必然存在的排序键再建一条二级索引。
pub(crate) fn generate_canonical_uuid_v7() -> String {
    Uuid::now_v7().hyphenated().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_lowercase_hyphenated_form_is_accepted() {
        let canonical = "018f3c9e-6c00-7000-8000-00000000abcd";
        assert_eq!(
            parse_canonical_uuid(canonical, Code::PromptIdInvalid)
                .expect("规范形式应被接受")
                .hyphenated()
                .to_string(),
            canonical
        );
        for other in [
            "018F3C9E-6C00-7000-8000-00000000ABCD",
            "{018f3c9e-6c00-7000-8000-00000000abcd}",
            "018f3c9e6c0070008000000000abcd12",
            "urn:uuid:018f3c9e-6c00-7000-8000-00000000abcd",
            "",
        ] {
            let err = parse_canonical_uuid(other, Code::PromptIdInvalid)
                .expect_err("非规范形式本应被拒绝");
            assert_eq!(err.code, Code::PromptIdInvalid, "被接受的字面值：{other:?}");
        }
    }

    #[test]
    fn generated_ids_are_canonical_time_ordered_v7() {
        let first = generate_canonical_uuid_v7();
        let second = generate_canonical_uuid_v7();
        for id in [&first, &second] {
            let u = parse_canonical_uuid(id, Code::PromptIdInvalid).expect("生成值应是规范形式");
            assert_eq!(u.get_version_num(), 7, "生成的不是 UUIDv7：{id}");
        }
        // 同一毫秒内生成的两个 v7 也不应相等；时间可排序只保证不递减，不保证严格递增。
        assert_ne!(first, second);
        assert!(first <= second, "v7 字面值顺序应与生成顺序一致");
    }
}
