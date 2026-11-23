/*
 * Vocabulary: the canonical labels of the unified 5-field format
 *   (patientId, label, value, time, source)
 *
 * Each entry:
 *   label       canonical label stored in the `label` field
 *   synonyms    page labels that mean the same thing (matched after normalisation)
 *   type        how the value is normalised: text | id | date | sex | number | bp | glucose | medication
 *   persistent  true → time is stored as "nan"
 *   sensitive   true → masked before anything is sent to AI; also used for identity
 *   identity    which identity hint this label provides (nationalId | name | mrn | bed | birthDate)
 *   unit/loinc/range  for numeric vitals (unit is the one canonical unit)
 *   multi       several values may share (patientId, label, time, source)
 *
 * Add your own system's wording to `synonyms`, or teach it in the side panel.
 */
(function (g) {
  const PDB = (g.PDB = g.PDB || {});

  const V = [
    // ── identity & demographics (persistent) ───────────────────────────
    { key: 'nationalId', label: 'National ID', type: 'id', persistent: true, sensitive: true, identity: 'nationalId',
      synonyms: ['身分證', '身分證號', '身分證字號', '身份證', '身份證號', '身份證字號', '個案身分證', '身分證或護照號',
        '身分證號碼', '統一證號', '居留證號', 'national id', 'id no', 'id number', 'idno', 'cid'] },
    { key: 'name', label: 'Name', type: 'text', persistent: true, sensitive: true, identity: 'name',
      synonyms: ['姓名', '病人姓名', '病患姓名', '患者姓名', '個案姓名', '案主姓名', '住民姓名', 'cname',
        'name', 'patient name', 'full name', 'patient'] },
    { key: 'mrn', label: 'MRN', type: 'id', persistent: true, sensitive: true, identity: 'mrn',
      synonyms: ['病歷號', '病歷號碼', '病歷編號', '個案編號', '收案編號', '住民編號', '病人編號', '病患編號', '案號',
        'patientno', 'mrn', 'medical record number', 'chart no', 'chart number', 'patient id', 'case no'] },
    { key: 'sex', label: 'Sex', type: 'sex', persistent: true, synonyms: ['性別', 'sex', 'gender'] },
    { key: 'birthDate', label: 'Birth date', type: 'date', persistent: true, sensitive: true, identity: 'birthDate',
      synonyms: ['生日', '出生日期', '出生年月日', '個案生日', 'birthday', 'dob', 'date of birth', 'birth date', 'birthdate'] },
    { key: 'age', label: 'Age', type: 'number', persistent: true, synonyms: ['年齡', '歲數', 'age'] },
    { key: 'nickname', label: 'Nickname', type: 'text', persistent: true, synonyms: ['暱稱', '傳統姓名', 'nickname'] },
    { key: 'bloodType', label: 'Blood type', type: 'text', persistent: true, synonyms: ['血型', 'blood type', 'abo'] },
    { key: 'phone', label: 'Phone', type: 'text', persistent: true, sensitive: true,
      synonyms: ['電話', '聯絡電話', '個案電話', '住家電話', 'phone', 'tel', 'telephone'] },
    { key: 'mobile', label: 'Mobile', type: 'text', persistent: true, sensitive: true, synonyms: ['手機', '行動電話', 'mobile', 'cell'] },
    { key: 'address', label: 'Address', type: 'text', persistent: true, sensitive: true,
      synonyms: ['地址', '住址', '通訊地址', '居住地址', '居住(通訊)地址', '聯絡地址', 'address', 'mailing address'] },
    { key: 'regAddress', label: 'Registered address', type: 'text', persistent: true, sensitive: true,
      synonyms: ['戶籍地址', '戶籍地', 'registered address'] },
    { key: 'email', label: 'Email', type: 'text', persistent: true, sensitive: true, synonyms: ['email', 'e-mail', '電子郵件'] },
    { key: 'nationality', label: 'Nationality', type: 'text', persistent: true, synonyms: ['國籍', 'nationality'] },
    { key: 'language', label: 'Language', type: 'text', persistent: true, synonyms: ['慣用語言', '常用語言', 'language'] },
    { key: 'marital', label: 'Marital status', type: 'text', persistent: true, synonyms: ['婚姻狀態', '婚姻', 'marital status'] },
    { key: 'education', label: 'Education', type: 'text', persistent: true, synonyms: ['教育程度', 'education'] },
    { key: 'religion', label: 'Religion', type: 'text', persistent: true, synonyms: ['宗教信仰', '宗教', 'religion'] },
    { key: 'allergies', label: 'Allergies', type: 'text', persistent: true,
      synonyms: ['過敏', '過敏史', '藥物過敏', 'allergy', 'allergies'] },
    { key: 'history', label: 'Medical history', type: 'text', persistent: true,
      synonyms: ['疾病史', '過去病史', '病史', 'medical history', 'past history'] },
    { key: 'diagnosis', label: 'Diagnosis', type: 'text', persistent: false,
      synonyms: ['診斷', '疾病診斷', '主診斷', 'diagnosis', 'dx'] },
    { key: 'bed', label: 'Bed', type: 'text', persistent: false, identity: 'bed', synonyms: ['床號', '床位', 'bed', 'bed no'] },
    { key: 'admissionDate', label: 'Admission date', type: 'date', persistent: true,
      synonyms: ['入住日', '入住日期', '入院日期', '收案日期', '開案日期', 'admission date', 'admit date'] },
    { key: 'dnr', label: 'DNR', type: 'text', persistent: true, synonyms: ['dnr', '不施行心肺復甦術'] },

    // ── vital signs (timed) ─────────────────────────────────────────────
    { key: 'temperature', label: 'Body temperature', type: 'number', unit: '°C', ucum: 'Cel', loinc: '8310-5', range: [30, 45],
      vital: true, synonyms: ['體溫', '溫度', '體溫測量', 'temp', 'temperature', 'body temperature', 'bt'] },
    { key: 'pulse', label: 'Heart rate', type: 'number', unit: '/min', ucum: '/min', loinc: '8867-4', range: [20, 250],
      vital: true, synonyms: ['脈搏', '心跳', '心率', '脈搏測量', 'pulse', 'hr', 'heart rate'] },
    { key: 'resp', label: 'Respiratory rate', type: 'number', unit: '/min', ucum: '/min', loinc: '9279-1', range: [4, 80],
      vital: true, synonyms: ['呼吸', '呼吸次數', '呼吸測量', 'rr', 'resp', 'respiration', 'respiratory rate'] },
    { key: 'bp', label: 'Blood pressure', type: 'bp', unit: 'mmHg', ucum: 'mm[Hg]', loinc: '85354-9', range: [20, 300],
      vital: true, synonyms: ['血壓', '血壓測量', 'bp', 'blood pressure', 'nibp'] },
    { key: 'bpSys', label: 'Systolic BP', type: 'number', unit: 'mmHg', range: [40, 300], vital: true, bpPart: 'sys',
      synonyms: ['收縮壓', 'sbp', 'systolic', 'systolic bp'] },
    { key: 'bpDia', label: 'Diastolic BP', type: 'number', unit: 'mmHg', range: [20, 200], vital: true, bpPart: 'dia',
      synonyms: ['舒張壓', 'dbp', 'diastolic', 'diastolic bp'] },
    { key: 'spo2', label: 'SpO2', type: 'number', unit: '%', ucum: '%', loinc: '59408-5', range: [40, 100],
      vital: true, synonyms: ['血氧', '血氧飽和度', '血氧測量', 'spo2', 'o2 sat', 'oxygen saturation'] },
    { key: 'glucose', label: 'Blood glucose', type: 'glucose', unit: 'mg/dL', ucum: 'mg/dL', loinc: '2339-0', range: [10, 1500],
      vital: true, synonyms: ['血糖', '血糖測量', '指尖血糖', 'glucose', 'blood glucose', 'blood sugar'] },
    { key: 'pain', label: 'Pain score', type: 'number', unit: '', ucum: '{score}', loinc: '72514-3', range: [0, 10],
      vital: true, synonyms: ['疼痛', '疼痛指數', '疼痛分數', 'pain', 'pain score'] },
    { key: 'height', label: 'Body height', type: 'number', unit: 'cm', ucum: 'cm', loinc: '8302-2', range: [30, 250],
      vital: true, synonyms: ['身高', '身高測量', 'height', 'body height'] },
    { key: 'weight', label: 'Body weight', type: 'number', unit: 'kg', ucum: 'kg', loinc: '29463-7', range: [0.3, 400],
      vital: true, synonyms: ['體重', '體重測量', 'weight', 'body weight'] },
    { key: 'bmi', label: 'BMI', type: 'number', unit: 'kg/m2', ucum: 'kg/m2', loinc: '39156-5', range: [8, 90],
      vital: true, synonyms: ['bmi', '身體質量指數'] },
    { key: 'adl', label: 'Barthel index', type: 'number', unit: '', range: [0, 100], synonyms: ['巴氏', '巴氏量表', 'adl', 'barthel'] },
    { key: 'kps', label: 'Karnofsky score', type: 'number', unit: '', range: [0, 100], synonyms: ['柯氏', 'kps', 'karnofsky'] },

    // ── medication (one row per medication, multi) ─────────────────────
    { key: 'medication', label: 'Medication', type: 'medication', multi: true, synonyms: ['藥名', '藥品名稱', 'drug', 'medication'] },
  ];

  // Parts that make up one Medication row (matched in the same table row).
  const MED_PARTS = {
    drug: ['藥名', '藥品名稱', 'drug', 'medication', 'drug name'],
    strength: ['劑量', 'strength'],
    strengthUnit: ['劑量單位'],
    dose: ['藥量', '用量', 'dose'],
    doseUnit: ['計數單位'],
    freq: ['頻率', '用法', 'frequency'],
    route: ['途徑', '用法途徑', 'route'],
    days: ['天數', 'days'],
    start: ['開始日期', '起止日', 'start date', 'start'],
    end: ['結束日期', 'end date', 'end'],
    hospital: ['醫療院所', '院所', 'hospital'],
    dept: ['就診科別', '科別', 'department'],
    doctor: ['醫師', 'doctor', 'physician'],
  };

  // A table column whose header is generic ("數據") takes its label from the page heading.
  const GENERIC_VALUE = ['數據', '數值', '測量值', '測量數據', '結果', 'value', 'result', 'reading'];

  // Headers that give a row its time.
  const TIME = ['測量日期', '測量時間', '紀錄時間', '記錄時間', '日期時間', '日期', '時間', '量測時間',
    'date', 'time', 'datetime', 'date/time', 'measured at', 'recorded at'];

  // Labels whose value is the date of the whole form (used as time for its timed rows).
  const RECORD_DATE = ['填表日期', '醫囑日期', '評估日期', '紀錄日期', '記錄日期', '訪視日期', 'record date', 'form date'];

  // Labels that are UI noise, never stored.
  const IGNORE = ['操作', '維護', '序', '項次', '查看', '下載', '刪除', '編輯', '複製', '列印', '選擇', '備註說明',
    '建檔人', '修改人', '快速搜尋', '搜尋', '關鍵字', 'action', 'actions',
    '機構名稱', '機構地址', '統編', '客服專線', '建議解析度', '清單顯示', '沒有權限可瀏覽', '頁面資訊'];

  const byKey = {};
  for (const v of V) byKey[v.key] = v;
  const byLabel = {};
  for (const v of V) byLabel[v.label] = v;

  PDB.schema = { VERSION: 2, VOCAB: V, byKey, byLabel, MED_PARTS, GENERIC_VALUE, TIME, RECORD_DATE, IGNORE };
})(globalThis);
