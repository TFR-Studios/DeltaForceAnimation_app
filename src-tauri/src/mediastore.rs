/* ============================================================================
 * Android:把导出的视频写进系统相册
 *
 * 为什么必须走 MediaStore
 * ----------------------
 * 相册(Google Photos / 各家 ROM 的图库)只索引 MediaStore 里的媒体项。
 * 文件写在应用私有目录里,相册永远看不到 —— 这正是「导出提示成功、相册里找不到」
 * 的根因。Android 10(API 29)起是分区存储:应用往 MediaStore 插入**自己的**
 * 媒体项不需要任何权限,也不需要 MANAGE_EXTERNAL_STORAGE,这是官方推荐做法。
 *
 * 为什么用 JNI 而不是写 Kotlin
 * ---------------------------
 * 项目原有口径是「不手写无法在本机验证的 Java/JNI」。这条这里是成立的:
 * 本文件能用 aarch64-linux-android 目标编译验证,也能在设备上跑通,并且可以直接用
 * "adb shell content query --uri content://media/external/video/media" 查回结果。
 * 相比之下多一个 Kotlin 文件会多一处「Rust 侧类名 ↔ Kotlin 侧包名」的隐式耦合。
 *
 * 为什么用 ndk_context 而不是 Tauri 插件句柄
 * ----------------------------------------
 * MediaStore 只需要 ContentResolver,而它从 Context 就能拿到,不需要 Activity。
 * 为一件事引入一整个 Tauri 移动插件(插件 crate + Kotlin 注解 + Gradle 依赖)不划算。
 * Context 由 tao 的 android 事件循环经 ndk_context 暴露出来。
 *
 * API 29 以下
 * -----------
 * RELATIVE_PATH 是 API 29 才有的列。更老的系统要先有 WRITE_EXTERNAL_STORAGE
 * 才能写公共目录,见 gen/android 的 MainActivity.kt 与 AndroidManifest.xml。
 * 这里在写入前先查一次权限,没有就明确报错,而不是让 MediaStore 抛一个难懂的异常。
 * ========================================================================== */
use jni::objects::{JObject, JString, JValue};
use jni::sys::jobject;
use jni::JavaVM;

/** 相册里的归属文件夹。放 Movies/ 下:系统图库与国内 ROM 都会扫到,
 *  又不会和用户自己的 DCIM 混在一起。 */
const ALBUM: &str = "Movies/三角洲行动动画编辑器";

/** MediaStore 接受之后的结果(显示名可能被系统改过,所以读回来)。 */
pub struct Saved {
    pub display_name: String,
    pub uri: String,
}

/** 收集一次 JNI 失败的可读原因:Java 侧抛了异常就把它 describe 到 logcat(stderr),
 *  用户看到的则是带上一步动作的短句 —— 比一句 "JNI error" 有用得多。 */
fn failed(env: &mut jni::JNIEnv<'_>, what: &str, e: impl std::fmt::Display) -> String {
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
        format!("{what}:Java 侧抛出异常(详见 logcat 的 RustStdoutStderr)")
    } else {
        format!("{what}:{e}")
    }
}

fn put_string(env: &mut jni::JNIEnv<'_>, cv: &JObject<'_>, key: &str, value: &str) -> Result<(), String> {
    let k = match env.new_string(key) { Ok(v) => v, Err(e) => return Err(format!("new_string({key}):{e}")) };
    let v = match env.new_string(value) { Ok(x) => x, Err(e) => return Err(format!("new_string({value}):{e}")) };
    let r = env.call_method(
        cv,
        "put",
        "(Ljava/lang/String;Ljava/lang/String;)V",
        &[JValue::Object(&k), JValue::Object(&v)],
    );
    r.map(|_| ()).map_err(|e| format!("ContentValues.put({key}):{e}"))
}

fn put_int(env: &mut jni::JNIEnv<'_>, cv: &JObject<'_>, key: &str, value: i32) -> Result<(), String> {
    let k = match env.new_string(key) { Ok(v) => v, Err(e) => return Err(format!("new_string({key}):{e}")) };
    let boxed = match env.new_object("java/lang/Integer", "(I)V", &[JValue::Int(value)]) {
        Ok(v) => v,
        Err(e) => return Err(format!("装箱 Integer({value}):{e}")),
    };
    let r = env.call_method(
        cv,
        "put",
        "(Ljava/lang/String;Ljava/lang/Integer;)V",
        &[JValue::Object(&k), JValue::Object(&boxed)],
    );
    r.map(|_| ()).map_err(|e| format!("ContentValues.put({key}):{e}"))
}

/** API < 29 上写公共目录要先有 WRITE_EXTERNAL_STORAGE;29 及以上分区存储不需要权限。 */
fn ensure_legacy_permission(env: &mut jni::JNIEnv<'_>, context: &JObject<'_>) -> Result<(), String> {
    const PERM: &str = "android.permission.WRITE_EXTERNAL_STORAGE";
    let sdk = match env.get_static_field("android/os/Build$VERSION", "SDK_INT", "I") {
        Ok(v) => v.i().unwrap_or(0),
        Err(e) => return Err(format!("读 Build.VERSION.SDK_INT:{e}")),
    };
    if sdk >= 29 {
        return Ok(());
    }
    let name = match env.new_string(PERM) { Ok(v) => v, Err(e) => return Err(format!("new_string:{e}")) };
    let r = env.call_method(
        context,
        "checkSelfPermission",
        "(Ljava/lang/String;)I",
        &[JValue::Object(&name)],
    );
    let granted = r.ok().and_then(|v| v.i().ok()).unwrap_or(-1) == 0;
    if granted {
        Ok(())
    } else {
        Err(format!("Android {sdk} 需要「存储」权限才能保存到相册;请在系统设置里授予后重试"))
    }
}

/** 读回 MediaStore 最终采用的显示名:同名文件已存在时系统会自动加 (1),
 *  不读回来的话界面显示的名字与相册里的真实名字会对不上。 */
fn query_display_name(env: &mut jni::JNIEnv<'_>, resolver: &JObject<'_>, uri: &JObject<'_>) -> Option<String> {
    let cols = env.new_object_array(1, "java/lang/String", JObject::null()).ok()?;
    let col = env.new_string("_display_name").ok()?;
    env.set_object_array_element(&cols, 0, &col).ok()?;
    let cursor = env
        .call_method(
            resolver,
            "query",
            "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
            &[
                JValue::Object(uri),
                JValue::Object(&cols),
                JValue::Object(&JObject::null()),
                JValue::Object(&JObject::null()),
                JValue::Object(&JObject::null()),
            ],
        )
        .ok()?
        .l()
        .ok()?;
    if cursor.is_null() {
        return None;
    }
    let moved = env.call_method(&cursor, "moveToFirst", "()Z", &[]).ok()?.z().unwrap_or(false);
    let out = if moved {
        env.call_method(&cursor, "getString", "(I)Ljava/lang/String;", &[JValue::Int(0)])
            .ok()
            .and_then(|v| v.l().ok())
            .and_then(|obj| {
                let js = JString::from(obj);
                env.get_string(&js).ok().map(|s| s.to_string_lossy().into_owned())
            })
    } else {
        None
    };
    let _ = env.call_method(&cursor, "close", "()V", &[]);
    out
}

/**
 * 把一份视频字节写进系统相册,返回被系统接受的显示名与 content URI。
 * 失败一律回可读原因:调用方(ipc.rs)会把它原样透到界面。
 */
pub fn save(display_name: &str, mime: &str, data: &[u8]) -> Result<Saved, String> {
    if data.is_empty() {
        return Err("收到 0 字节".to_string());
    }

    let ctx = ndk_context::android_context();
    let vm = match unsafe { JavaVM::from_raw(ctx.vm().cast()) } {
        Ok(v) => v,
        Err(e) => return Err(format!("取 JavaVM 失败:{e}")),
    };
    let mut env = match vm.attach_current_thread() {
        Ok(v) => v,
        Err(e) => return Err(format!("attach 当前线程失败:{e}")),
    };

    /* ndk_context 持有的是**全局引用**,不能交给 JObject 的 Drop 去 DeleteLocalRef,
     * 所以包在 ManuallyDrop 里,只借用、不释放。 */
    let context = std::mem::ManuallyDrop::new(unsafe { JObject::from_raw(ctx.context() as jobject) });

    ensure_legacy_permission(&mut env, &context)?;

    /* ---- 1) ContentValues:先标记 is_pending=1,写完再置 0。
     * 图库在这期间不会扫到半个文件(否则会出现「看得见但打不开」的条目)。 ---- */
    let values = match env.new_object("android/content/ContentValues", "()V", &[]) {
        Ok(v) => v,
        Err(e) => return Err(failed(&mut env, "构造 ContentValues", e)),
    };
    put_string(&mut env, &values, "_display_name", display_name)?;
    put_string(&mut env, &values, "mime_type", mime)?;
    put_string(&mut env, &values, "relative_path", ALBUM)?;
    put_int(&mut env, &values, "is_pending", 1)?;

    /* ---- 2) resolver.insert(Video.EXTERNAL_CONTENT_URI, values) ---- */
    let resolver = match env.call_method(
        &*context,
        "getContentResolver",
        "()Landroid/content/ContentResolver;",
        &[],
    ) {
        Ok(v) => match v.l() { Ok(x) => x, Err(e) => return Err(failed(&mut env, "取 ContentResolver", e)) },
        Err(e) => return Err(failed(&mut env, "调 getContentResolver", e)),
    };
    let collection = match env.get_static_field(
        "android/provider/MediaStore$Video$Media",
        "EXTERNAL_CONTENT_URI",
        "Landroid/net/Uri;",
    ) {
        Ok(v) => match v.l() { Ok(x) => x, Err(e) => return Err(failed(&mut env, "取 Video 集合 Uri", e)) },
        Err(e) => return Err(failed(&mut env, "读 MediaStore.Video.Media", e)),
    };
    let uri = match env.call_method(
        &resolver,
        "insert",
        "(Landroid/net/Uri;Landroid/content/ContentValues;)Landroid/net/Uri;",
        &[JValue::Object(&collection), JValue::Object(&values)],
    ) {
        Ok(v) => match v.l() { Ok(x) => x, Err(e) => return Err(failed(&mut env, "insert 返回", e)) },
        Err(e) => return Err(failed(&mut env, "调 ContentResolver.insert", e)),
    };
    if uri.is_null() {
        return Err("MediaStore 拒绝了这次插入(insert 返回 null)".to_string());
    }

    /* ---- 3) openOutputStream 写入字节 ---- */
    let stream = match env.call_method(
        &resolver,
        "openOutputStream",
        "(Landroid/net/Uri;)Ljava/io/OutputStream;",
        &[JValue::Object(&uri)],
    ) {
        Ok(v) => match v.l() { Ok(x) => x, Err(e) => return Err(failed(&mut env, "打开输出流", e)) },
        Err(e) => return Err(failed(&mut env, "调 openOutputStream", e)),
    };
    if stream.is_null() {
        return Err("打开相册输出流失败(openOutputStream 返回 null)".to_string());
    }
    let bytes = match env.byte_array_from_slice(data) {
        Ok(v) => v,
        Err(e) => return Err(failed(&mut env, "构造字节数组", e)),
    };
    if let Err(e) = env.call_method(&stream, "write", "([B)V", &[JValue::Object(&bytes)]) {
        return Err(failed(&mut env, "写入相册文件", e));
    }
    if let Err(e) = env.call_method(&stream, "close", "()V", &[]) {
        return Err(failed(&mut env, "关闭输出流", e));
    }

    /* ---- 4) is_pending = 0:到这一步图库才会把这一项当成有效媒体 ---- */
    let done = match env.new_object("android/content/ContentValues", "()V", &[]) {
        Ok(v) => v,
        Err(e) => return Err(failed(&mut env, "构造收尾 ContentValues", e)),
    };
    put_int(&mut env, &done, "is_pending", 0)?;
    let _ = env.call_method(
        &resolver,
        "update",
        "(Landroid/net/Uri;Landroid/content/ContentValues;Ljava/lang/String;[Ljava/lang/String;)I",
        &[
            JValue::Object(&uri),
            JValue::Object(&done),
            JValue::Object(&JObject::null()),
            JValue::Object(&JObject::null()),
        ],
    );

    /* ---- 5) 读回真实显示名与 URI ---- */
    let real_name = query_display_name(&mut env, &resolver, &uri).unwrap_or_else(|| display_name.to_string());
    let uri_text = env
        .call_method(&uri, "toString", "()Ljava/lang/String;", &[])
        .ok()
        .and_then(|v| v.l().ok())
        .and_then(|obj| {
            let js = JString::from(obj);
            env.get_string(&js).ok().map(|s| s.to_string_lossy().into_owned())
        })
        .unwrap_or_default();

    Ok(Saved { display_name: real_name, uri: uri_text })
}
