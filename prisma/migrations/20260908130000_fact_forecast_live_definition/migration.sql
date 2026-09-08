-- Capture the FactForecast definition that is actually live in the database.
--
-- The view had been replaced directly in SQL Server, so the migration history no
-- longer described it: the newest migration file (20260713123000) built a
-- 108-line view that recomputes price as CPL + spread from forecast_values,
-- while the live view is a 444-line historical snapshot reading
-- forecast_change_logs and using the stored newPriceFcst / newAmountFcst.
-- A database provisioned from migrations therefore produced different numbers in
-- Power BI than production. This migration makes the repository match reality.
--
-- Dumped from sys.sql_modules on 2026-09-08, body unchanged apart from
-- CREATE VIEW -> CREATE OR ALTER VIEW so re-running is safe.

CREATE OR ALTER VIEW [dbo].[FactForecast]
AS
/*
    Historical Forecast Snapshot

    Full Snapshot:
    - Period ครบเท่ากับจำนวน Period สูงสุดของ Version
    - จำนวน Log ไม่น้อยกว่า 80% ของ Batch ใหญ่ที่สุด

    Partial Update:
    - ใช้ Full Snapshot ล่าสุดเป็นฐาน
    - นำค่าใหม่ใน Partial Batch มาแทนค่าฐาน

    ใช้ข้อมูล Historical โดยตรง:
    - newQtyFcst
    - newPriceFcst
    - newAmountFcst
*/

SELECT
    CONCAT(
        COALESCE(
            CONVERT(NVARCHAR(20), versions.[versionKey]),
            LTRIM(RTRIM(revision.[versionName]))
        ),
        N'-',
        CONVERT(
            CHAR(10),
            revision.[revisionDate],
            105
        ),
        N'-',
        REPLACE(
            CONVERT(
                CHAR(12),
                CAST(revision.[revisionDate] AS DATETIME2(3)),
                114
            ),
            N':',
            N''
        ),
        N'-',
        revision.[changedBy]
    ) AS [Fcst Rev Key],

    CONCAT(
        CONVERT(
            CHAR(10),
            revision.[revisionDate],
            105
        ),
        N'-',
        REPLACE(
            CONVERT(
                CHAR(12),
                CAST(revision.[revisionDate] AS DATETIME2(3)),
                114
            ),
            N':',
            N''
        ),
        N'-',
        revision.[changedBy]
    ) AS [Revision],

    revision.[versionName] AS [Forecast Version],

    versions.[versionKey] AS [Version Key],

    COALESCE(
        NULLIF(managed.[newKey], N''),
        forecastKey.[registrationId]
    ) AS [Registration Key],

    DATEFROMPARTS(
        YEAR(forecastKey.[period]),
        MONTH(forecastKey.[period]),
        1
    ) AS [Fcst Period],

    CAST(
        snapshotValue.[newQtyFcst]
        AS DECIMAL(18, 4)
    ) AS [NewQty],

    CAST(
        snapshotValue.[newPriceFcst]
        AS DECIMAL(18, 4)
    ) AS [Price],

    CAST(
        snapshotValue.[newAmountFcst]
        AS DECIMAL(18, 4)
    ) AS [Amount],

    revision.[stampPeriod] AS [Stamp Period],

    revision.[revisionDate] AS [updatedAt]

FROM
(
    /*
        แปลง Base Token กลับเป็น:

        - baseBatchId
        - baseCutoff
    */
    SELECT
        revisionBase.*,

        RIGHT(
            revisionBase.[baseToken],
            36
        ) AS [baseBatchId],

        TRY_CONVERT(
            DATETIME2(7),
            LEFT(
                revisionBase.[baseToken],
                27
            ),
            126
        ) AS [baseCutoff]

    FROM
    (
        /*
            หา Full Snapshot ล่าสุด
            ก่อนหรือเท่ากับ Revision ปัจจุบัน

            Token ประกอบด้วย:
            revisionCutoff + batchId
        */
        SELECT
            classified.*,

            MAX(
                CASE
                    WHEN classified.[IsFullSnapshot] = 1
                    THEN CONCAT(
                        CONVERT(
                            NVARCHAR(27),
                            CAST(
                                classified.[revisionCutoff]
                                AS DATETIME2(7)
                            ),
                            126
                        ),
                        N'|',
                        classified.[batchId]
                    )
                END
            ) OVER
            (
                PARTITION BY classified.[versionName]

                ORDER BY
                    classified.[revisionCutoff],
                    classified.[batchId]

                ROWS BETWEEN
                    UNBOUNDED PRECEDING
                    AND CURRENT ROW
            ) AS [baseToken]

        FROM
        (
            /*
                จำแนก Batch:

                1 = Full Snapshot
                0 = Partial Update
            */
            SELECT
                thresholdValue.*,

                CASE
                    /*
                        Batch แรกของ Version
                        ถือเป็น Snapshot เริ่มต้น
                    */
                    WHEN thresholdValue.[BatchSequence] = 1
                        THEN 1

                    /*
                        Full Snapshot:
                        - Period ครบ
                        - จำนวนข้อมูลอย่างน้อย 80%
                          ของ Batch ใหญ่ที่สุด
                    */
                    WHEN
                        thresholdValue.[PeriodCount]
                        = thresholdValue.[MaxPeriodCount]

                        AND
                        thresholdValue.[LogRowCount] * 1.0
                        /
                        NULLIF(
                            thresholdValue.[MaxLogRowCount],
                            0
                        ) >= 0.80

                        THEN 1

                    ELSE 0
                END AS [IsFullSnapshot]

            FROM
            (
                /*
                    คำนวณจำนวน Period สูงสุด
                    และจำนวนข้อมูลสูงสุดของ Version
                */
                SELECT
                    batchStats.*,

                    MAX(
                        batchStats.[PeriodCount]
                    ) OVER
                    (
                        PARTITION BY batchStats.[versionName]
                    ) AS [MaxPeriodCount],

                    MAX(
                        batchStats.[LogRowCount]
                    ) OVER
                    (
                        PARTITION BY batchStats.[versionName]
                    ) AS [MaxLogRowCount],

                    ROW_NUMBER() OVER
                    (
                        PARTITION BY batchStats.[versionName]

                        ORDER BY
                            batchStats.[revisionCutoff],
                            batchStats.[batchId]
                    ) AS [BatchSequence]

                FROM
                (
                    /*
                        สรุปข้อมูลแต่ละ Batch
                    */
                    SELECT
                        changeLog.[versionName],
                        changeLog.[batchId],

                        MAX(
                            changeLog.[changedAt]
                        ) AS [revisionCutoff],

                        COALESCE(
                            MAX(commitBatch.[createdAt]),
                            MAX(changeLog.[changedAt])
                        ) AS [revisionDate],

                        COALESCE(
                            NULLIF(
                                MAX(
                                    LTRIM(
                                        RTRIM(
                                            commitBatch.[changedBy]
                                        )
                                    )
                                ),
                                N''
                            ),
                            N'sales-forecast-web'
                        ) AS [changedBy],

                        COALESCE(
                            NULLIF(
                                MAX(
                                    LTRIM(
                                        RTRIM(
                                            commitBatch.[stampPeriod]
                                        )
                                    )
                                ),
                                N''
                            ),
                            N'No'
                        ) AS [stampPeriod],

                        COUNT(*) AS [LogRowCount],

                        COUNT(
                            DISTINCT changeLog.[period]
                        ) AS [PeriodCount]

                    FROM [dbo].[forecast_change_logs] AS changeLog

                    LEFT JOIN [dbo].[forecast_commit_batches]
                        AS commitBatch
                        ON commitBatch.[id]
                           = changeLog.[batchId]

                    GROUP BY
                        changeLog.[versionName],
                        changeLog.[batchId]
                ) AS batchStats
            ) AS thresholdValue
        ) AS classified
    ) AS revisionBase
) AS revision

/*
    Forecast Version Master
*/
LEFT JOIN
(
    SELECT
        LTRIM(RTRIM([name])) AS [name],
        MAX([versionKey]) AS [versionKey]

    FROM [dbo].[forecast_versions]

    GROUP BY
        LTRIM(RTRIM([name]))
) AS versions
    ON versions.[name]
       = LTRIM(RTRIM(revision.[versionName]))

/*
    สร้างรายการ Forecast Key จาก:

    1. รายการทั้งหมดใน Full Snapshot ฐาน
    2. รายการที่เพิ่มหรือแก้ใน Partial Update
*/
CROSS APPLY
(
    SELECT DISTINCT
        historyKey.[registrationId],
        historyKey.[granularity],
        historyKey.[period]

    FROM [dbo].[forecast_change_logs] AS historyKey

    WHERE historyKey.[versionName]
          = revision.[versionName]

      AND
      (
          /*
              ข้อมูลจาก Full Snapshot ฐาน
          */
          historyKey.[batchId]
              = revision.[baseBatchId]

          OR

          /*
              ข้อมูล Partial หลัง Full Snapshot
              จนถึง Revision ปัจจุบัน
          */
          (
              historyKey.[changedAt]
                  > revision.[baseCutoff]

              AND historyKey.[changedAt]
                  <= revision.[revisionCutoff]
          )
      )
) AS forecastKey

/*
    เลือกค่าล่าสุดของแต่ละ Forecast Key

    ถ้ามี Partial Update:
    ค่าใน Partial จะถูกเลือกแทนค่าจาก Full Snapshot
*/
CROSS APPLY
(
    SELECT TOP (1)
        historyValue.[newQtyFcst],
        historyValue.[newPriceFcst],
        historyValue.[newAmountFcst]

    FROM [dbo].[forecast_change_logs] AS historyValue

    WHERE historyValue.[versionName]
          = revision.[versionName]

      AND historyValue.[registrationId]
          = forecastKey.[registrationId]

      AND historyValue.[granularity]
          = forecastKey.[granularity]

      AND historyValue.[period]
          = forecastKey.[period]

      AND
      (
          historyValue.[batchId]
              = revision.[baseBatchId]

          OR
          (
              historyValue.[changedAt]
                  > revision.[baseCutoff]

              AND historyValue.[changedAt]
                  <= revision.[revisionCutoff]
          )
      )

    ORDER BY
        historyValue.[changedAt] DESC,
        historyValue.[id] DESC
) AS snapshotValue

/*
    แปลง Registration ID เดิมเป็น New Key
*/
OUTER APPLY
(
    SELECT TOP (1)
        master.[newKey]

    FROM [dbo].[master_data_crm_registrations] AS master

    WHERE master.[id]
          = forecastKey.[registrationId]

       OR master.[newKey]
          = forecastKey.[registrationId]

    ORDER BY
        CASE
            WHEN master.[id]
                 = forecastKey.[registrationId]
                THEN 1
            ELSE 2
        END,
        master.[id]
) AS managed

WHERE
    revision.[baseBatchId] IS NOT NULL

    AND forecastKey.[period] IS NOT NULL;
