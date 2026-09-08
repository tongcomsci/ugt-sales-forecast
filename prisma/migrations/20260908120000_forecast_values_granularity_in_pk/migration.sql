-- Add [granularity] to the forecast_values primary key.
--
-- A monthly row is stored on the 1st of the month; a weekly row is stored on the
-- first Wednesday (see firstWednesdayPeriod in src/lib/forecastPeriod.ts). When
-- the 1st IS a Wednesday both map to the same DATE, so with a key of
-- (registrationId, versionName, period) the two rows collide: the import MERGE
-- matches the wrong row and its "UPDATE SET granularity = ..." silently converts
-- it, dropping the value out of the other granularity's reads.
--
-- Widening a key can never introduce a duplicate, so no data cleanup is needed.
-- [granularity] is already NOT NULL, which a key column requires.

IF EXISTS (
  SELECT 1
  FROM sys.key_constraints
  WHERE parent_object_id = OBJECT_ID(N'[dbo].[forecast_values]')
    AND type = 'PK'
)
AND NOT EXISTS (
  SELECT 1
  FROM sys.key_constraints kc
  JOIN sys.indexes i
    ON i.object_id = kc.parent_object_id AND i.index_id = kc.unique_index_id
  JOIN sys.index_columns ic
    ON ic.object_id = i.object_id AND ic.index_id = i.index_id
  JOIN sys.columns c
    ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE kc.parent_object_id = OBJECT_ID(N'[dbo].[forecast_values]')
    AND kc.type = 'PK'
    AND c.name = N'granularity'
)
BEGIN
  DECLARE @pkName SYSNAME = (
    SELECT name
    FROM sys.key_constraints
    WHERE parent_object_id = OBJECT_ID(N'[dbo].[forecast_values]')
      AND type = 'PK'
  );

  EXEC(N'ALTER TABLE [dbo].[forecast_values] DROP CONSTRAINT [' + @pkName + N']');

  ALTER TABLE [dbo].[forecast_values]
    ADD CONSTRAINT [forecast_values_pkey]
    PRIMARY KEY CLUSTERED (
      [registrationId],
      [versionName],
      [period],
      [granularity]
    );
END;
